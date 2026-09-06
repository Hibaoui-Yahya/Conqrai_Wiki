import { Injectable, Logger } from '@nestjs/common';
import { createPrivateKey, randomUUID, sign as edSign } from 'node:crypto';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

/**
 * Where a ConqrPlan agent tool runs.
 *
 * The seventeen pure ConqrPlan tools exist twice during the migration: the
 * implementation that has always run inside Hub, and the extracted MCP
 * service. This decides which one answers, per tool, from configuration.
 *
 * Two rules make that safe, and they are the reason this is a router rather
 * than a client with a fallback.
 *
 * **One mutation reaches exactly one implementation.** There is no failover.
 * If the remote call fails in a way that leaves the outcome unknown - a
 * timeout, a dropped connection - retrying it against the local path would
 * risk creating the work item twice, and the caller would have no way to tell.
 * The error is surfaced with the idempotency key instead, so the write can be
 * resolved by reading it back rather than by guessing.
 *
 * **The idempotency key does not depend on the route.** It is derived from the
 * request, so the same logical write carries the same key whether it goes
 * local or remote, and a retry after a routing change still collides with the
 * original rather than duplicating it.
 */

export type ToolRoute = 'local' | 'mcp';

/** Raised when a routed mutation's outcome could not be established. */
export class UncertainMutationError extends Error {
  constructor(
    readonly toolName: string,
    readonly idempotencyKey: string | undefined,
    cause: string,
  ) {
    super(
      `ConqrPlan tool ${toolName} did not report an outcome (${cause}). ` +
        (idempotencyKey
          ? `Resolve by reading back external_id ${idempotencyKey} before retrying.`
          : 'Read the work item back before retrying.'),
    );
    this.name = 'UncertainMutationError';
  }
}

@Injectable()
export class ConqrPlanToolRouter {
  private readonly logger = new Logger(ConqrPlanToolRouter.name);

  constructor(private readonly environment: EnvironmentService) {}

  /**
   * Which implementation answers for a tool.
   *
   * Precedence, most specific first: an explicit per-tool list, then the
   * service-wide default, then local. Local is the default everywhere so that
   * deploying the service changes nothing until a route is turned on
   * deliberately - and so rollback is removing a name from a list.
   */
  routeFor(toolName: string): ToolRoute {
    if (!this.environment.getConqrPlanMcpUrl()) return 'local';
    const routed = this.environment.getConqrPlanMcpRoutedTools();
    if (routed.includes('*')) return 'mcp';
    return routed.includes(toolName) ? 'mcp' : 'local';
  }

  /** True when any route is active, for health reporting. */
  isRoutingAnything(): boolean {
    return Boolean(
      this.environment.getConqrPlanMcpUrl() &&
        this.environment.getConqrPlanMcpRoutedTools().length,
    );
  }

  /**
   * Issue an assertion naming the human, addressed to the MCP service.
   *
   * Hub signs with its own Ed25519 private key; the MCP service holds only the
   * public half. Nothing here can mint a ConqrPlan-addressed token - that is
   * the service's job with its own key, and keeping the two separate is what
   * makes each issuer's compromise attributable to it.
   */
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
   * A transport failure on a mutation is reported as uncertain rather than
   * retried anywhere: the request may or may not have been applied, and only
   * reading it back can tell.
   */
  async callRemote(params: {
    toolName: string;
    args: Record<string, unknown>;
    personUid: string;
    orgUid: string;
    scopes: string[];
    mutating: boolean;
    idempotencyKey?: string;
  }): Promise<unknown> {
    const url = this.environment.getConqrPlanMcpUrl();
    if (!url) throw new Error('ConqrPlan MCP routing is not configured');

    const { token, jti } = this.assertionFor(
      params.personUid,
      params.orgUid,
      params.scopes,
      this.environment.getConqrPlanMcpAssertionTtlSeconds(),
    );

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.environment.getConqrPlanMcpTimeoutMs(),
    );
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/mcp`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.environment.getConqrPlanMcpClientToken()}`,
          'X-Conqr-Delegation': token,
          'X-Conqr-Correlation-Id': jti,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: jti,
          method: 'tools/call',
          params: { name: params.toolName, arguments: params.args },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // A refusal is a definite outcome: nothing was applied, so it is an
        // ordinary error rather than an uncertain write.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`ConqrPlan MCP refused ${params.toolName}: ${res.status} ${body}`);
        }
        if (params.mutating) {
          throw new UncertainMutationError(
            params.toolName,
            params.idempotencyKey,
            `HTTP ${res.status}`,
          );
        }
        throw new Error(`ConqrPlan MCP failed ${params.toolName}: ${res.status} ${body}`);
      }

      const payload = (await res.json()) as {
        result?: { content?: { text?: string }[] };
      };
      const text = payload.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : undefined;
    } catch (err) {
      if (err instanceof UncertainMutationError) throw err;
      const aborted = (err as Error)?.name === 'AbortError';
      if (params.mutating && (aborted || err instanceof TypeError)) {
        throw new UncertainMutationError(
          params.toolName,
          params.idempotencyKey,
          aborted ? 'timeout' : 'connection failed',
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
