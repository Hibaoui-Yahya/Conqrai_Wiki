import { Injectable, Logger } from '@nestjs/common';
import { createPrivateKey, randomUUID, sign as edSign } from 'node:crypto';
import {
  isMutatingTool,
  PRE_DISPATCH_REFUSALS,
  recoveryFor,
  scopesForTool,
} from '@conqr/conqrplan-core';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

/**
 * Where a ConqrPlan agent tool runs.
 *
 * The seventeen pure ConqrPlan tools exist twice during the migration: the
 * implementation that has always run inside Hub, and the extracted MCP
 * service. This decides which one answers, per tool, from configuration.
 *
 * Routing mode is explicit. "Local" is a choice, not what happens when the
 * remote configuration is wrong: a tool listed for remote execution whose
 * service is unconfigured reports unavailable rather than quietly running
 * locally. Silently reverting would mean an operator who fat-fingered a URL
 * believes traffic moved when it never left, and a rollback nobody performed
 * looks identical to one that worked.
 */

export type ToolRoute = 'local' | 'mcp';

/** Raised when a routed mutation's outcome could not be established. */
export class UncertainMutationError extends Error {
  readonly uncertain = true;
  constructor(
    readonly toolName: string,
    readonly idempotencyKey: string | undefined,
    cause: string,
  ) {
    const guidance = recoveryFor(toolName);
    // Operation-specific, because "read it back by external_id" is only true
    // for create and is actively misleading for an update or a comment.
    super(
      `ConqrPlan tool ${toolName} did not report an outcome (${cause}). ` +
        `Operation type: ${guidance.kind}. ${guidance.evidence} ${guidance.safeRecovery}` +
        (idempotencyKey ? ` Idempotency key: ${idempotencyKey}.` : '') +
        ` Unsafe to retry when: ${guidance.unsafeRetryWhen}`,
    );
    this.name = 'UncertainMutationError';
  }
}

/** Raised when a tool is configured for remote execution but cannot reach it. */
export class RoutingUnavailableError extends Error {
  constructor(toolName: string, reason: string) {
    super(`ConqrPlan tool ${toolName} is routed to the MCP service but ${reason}`);
    this.name = 'RoutingUnavailableError';
  }
}

@Injectable()
export class ConqrPlanToolRouter {
  private readonly logger = new Logger(ConqrPlanToolRouter.name);

  constructor(private readonly environment: EnvironmentService) {}

  /** Tools this router may take over. Everything else stays where it is. */
  isRoutable(toolName: string): boolean {
    return scopesForTool(toolName).length > 0;
  }

  /**
   * Which implementation answers for a tool.
   *
   * Precedence: an explicit per-tool list, then the wildcard, then local. A
   * name only reaches 'mcp' by being listed, so deploying the service changes
   * nothing until someone opts a tool in, and removing the name is the whole
   * of the rollback for subsequent requests.
   */
  routeFor(toolName: string): ToolRoute {
    if (!this.isRoutable(toolName)) return 'local';
    const routed = this.environment.getConqrPlanMcpRoutedTools();
    if (routed.includes('*') || routed.includes(toolName)) return 'mcp';
    return 'local';
  }

  /**
   * Why a remote route cannot be served, or null when it can.
   *
   * Checked before dispatch so a misconfiguration is a clear error rather than
   * a silent downgrade.
   */
  private unavailableReason(): string | null {
    const url = this.environment.getConqrPlanMcpUrl();
    if (!url) return 'no service URL is configured (CONQRPLAN_MCP_URL)';
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return `the service URL is not http(s): ${url}`;
    } catch {
      return `the service URL is not a valid URL: ${url}`;
    }
    if (!this.environment.getConqrPlanMcpClientToken()) {
      return 'no client token is configured (CONQRPLAN_MCP_CLIENT_TOKEN)';
    }
    if (!this.environment.getConqrHubAssertionPrivateKey()) {
      return 'no assertion signing key is configured (CONQRHUB_ASSERTION_PRIVATE_KEY_PEM)';
    }
    if (!this.environment.getConqrHubAssertionKeyId()) {
      return 'no assertion key id is configured (CONQRHUB_ASSERTION_KEY_ID)';
    }
    return null;
  }

  /** Validate routing configuration once, at boot, so it fails loudly. */
  assertConfigurationCoherent(): void {
    const routed = this.environment.getConqrPlanMcpRoutedTools();
    if (!routed.length) return;
    const reason = this.unavailableReason();
    if (reason) {
      throw new Error(
        `ConqrPlan MCP routing lists ${routed.join(', ')} but ${reason}. ` +
          'Fix the configuration or clear CONQRPLAN_MCP_ROUTED_TOOLS to run locally.',
      );
    }
  }

  private assertionFor(
    personUid: string,
    orgUid: string,
    scopes: string[],
    ttlSeconds: number,
  ): { token: string; jti: string } {
    const b64 = (input: Buffer | string) =>
      Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const header = b64(
      JSON.stringify({
        alg: 'EdDSA',
        typ: 'CONQR-OBO',
        kid: this.environment.getConqrHubAssertionKeyId(),
      }),
    );
    const payload = b64(
      JSON.stringify({
        sub: personUid,
        tid: orgUid,
        aud: 'conqrplan-mcp',
        scope: scopes,
        iat: now,
        nbf: now,
        exp: now + ttlSeconds,
        act: 'obo',
        iss: this.environment.getConqrOboIssuer(),
        jti,
      }),
    );
    const key = createPrivateKey(this.environment.getConqrHubAssertionPrivateKey());
    const signature = b64(edSign(null, Buffer.from(`${header}.${payload}`, 'utf8'), key));
    return { token: `${header}.${payload}.${signature}`, jti };
  }

  /**
   * Invoke a tool on the MCP service.
   *
   * Outcome classification is the part that matters. A refusal the service
   * raised before running the tool proves nothing was written; anything else
   * on a mutation is uncertain and is reported as such, with the idempotency
   * key, so the caller resolves it by reading back rather than by creating a
   * second time. There is no failover: retrying the other implementation is
   * exactly how a duplicate gets made.
   */
  async callRemote(params: {
    toolName: string;
    args: Record<string, unknown>;
    personUid: string;
    orgUid: string;
    correlationId?: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    const reason = this.unavailableReason();
    if (reason) throw new RoutingUnavailableError(params.toolName, reason);

    const mutating = isMutatingTool(params.toolName);
    const scopes = scopesForTool(params.toolName);
    const { token, jti } = this.assertionFor(
      params.personUid,
      params.orgUid,
      scopes,
      this.environment.getConqrPlanMcpAssertionTtlSeconds(),
    );
    const correlationId = params.correlationId ?? jti;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.environment.getConqrPlanMcpTimeoutMs(),
    );

    let res: Response;
    try {
      res = await fetch(
        `${this.environment.getConqrPlanMcpUrl().replace(/\/$/, '')}/mcp`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.environment.getConqrPlanMcpClientToken()}`,
            'X-Conqr-Delegation': token,
            'X-Conqr-Correlation-Id': correlationId,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: correlationId,
            method: 'tools/call',
            params: { name: params.toolName, arguments: params.args },
          }),
        },
      );
    } catch (err) {
      // The request left; we do not know whether it was applied.
      const aborted = (err as Error)?.name === 'AbortError';
      if (mutating) {
        throw new UncertainMutationError(
          params.toolName,
          params.idempotencyKey,
          aborted ? 'timeout' : `transport failure: ${(err as Error).message}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let classification: string | undefined;
      try {
        classification = JSON.parse(body)?.error;
      } catch {
        /* body is not JSON */
      }

      // Only a refusal we know happens before the tool runs proves no write.
      if (classification && PRE_DISPATCH_REFUSALS.has(classification)) {
        throw new Error(
          `ConqrPlan MCP refused ${params.toolName} (${classification}); nothing was applied`,
        );
      }
      if (mutating) {
        throw new UncertainMutationError(
          params.toolName,
          params.idempotencyKey,
          `HTTP ${res.status}${classification ? ` ${classification}` : ''}`,
        );
      }
      throw new Error(`ConqrPlan MCP failed ${params.toolName}: ${res.status} ${body}`);
    }

    // A 200 carries the tool's own structured outcome: success, a ConqrPlan
    // refusal, a partial write with per-field errors, or per-item bulk
    // results. All of those are definite and are returned verbatim so the
    // caller sees exactly what the local implementation would have returned.
    const payload = (await res.json()) as { result?: { content?: { text?: string }[] } };
    const text = payload.result?.content?.[0]?.text;
    this.logger.debug(
      `Routed ${params.toolName} to MCP (correlationId ${correlationId})`,
    );
    return text ? JSON.parse(text) : undefined;
  }
}
