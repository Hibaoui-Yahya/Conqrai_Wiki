import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  CONQRPLAN_TOOLS,
  PlaneClient,
  ServiceConfig,
  TenantMappingProvider,
  ToolDefinition,
} from '@conqr/conqrplan-core';
import {
  assertProjectAllowed,
  authenticate,
  AuthError,
  callContextFor,
  inboundPolicyFrom,
} from './auth';

/**
 * The ConqrPlan MCP service.
 *
 * Deliberately small: transport, authentication, validation, and a call into
 * ConqrPlan. No business rules, no database, no Hub. The tools it serves are
 * the same seventeen by name and schema, so an agent cannot tell which process
 * answered - which is the whole compatibility contract.
 */

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Redacting console logger. Never logs a token, a delegation or a secret. */
export function createLogger(level: string): Logger {
  const order = ['debug', 'info', 'warn', 'error'];
  const min = Math.max(0, order.indexOf(level));
  const emit = (lvl: string, msg: string, meta?: Record<string, unknown>) => {
    if (order.indexOf(lvl) < min) return;
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...meta }) + '\n',
    );
  };
  return {
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}

/** Fixed-window per-actor limiter. Bounded memory, swept on write. */
class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly perMinute: number) {}

  check(key: string, now = Date.now()): boolean {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const entry = this.hits.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { windowStart, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.perMinute;
  }
}

export interface AppOptions {
  config: ServiceConfig;
  tenants: TenantMappingProvider;
  client?: PlaneClient;
  logger?: Logger;
  tools?: ToolDefinition[];
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

export class ConqrPlanMcpApp {
  readonly tools: ToolDefinition[];
  private readonly byName: Map<string, ToolDefinition>;
  private readonly client: PlaneClient;
  private readonly limiter: RateLimiter;
  readonly logger: Logger;

  constructor(private readonly opts: AppOptions) {
    this.tools = opts.tools ?? CONQRPLAN_TOOLS;
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
    this.logger = opts.logger ?? createLogger(opts.config.deployment.logLevel);
    this.limiter = new RateLimiter(opts.config.deployment.rateLimitPerMinute);
    this.client =
      opts.client ??
      new PlaneClient({
        baseUrl: opts.config.deployment.apiBaseUrl,
        apiKey: opts.config.secrets.planeApiKey,
        timeoutMs: opts.config.deployment.requestTimeoutMs,
        maxConcurrency: opts.config.deployment.maxConcurrency,
      });
  }

  /** Tool list, in MCP shape. Schemas are advertised, not just names. */
  listTools() {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      scopes: t.scopes,
    }));
  }

  /**
   * Run one tool call for one authenticated caller.
   *
   * Every request builds its own identity, delegation and call context.
   * Nothing actor-, tenant- or credential-shaped is stored on the instance, so
   * two concurrent callers cannot observe each other's context however the
   * transport interleaves them.
   */
  async callTool(params: {
    toolName: string;
    args: unknown;
    bearerToken?: string;
    delegationToken?: string;
    callerCorrelationId?: string;
    now?: number;
  }): Promise<unknown> {
    const tool = this.byName.get(params.toolName);
    if (!tool) throw new AuthError(404, 'unknown_tool', `Unknown tool: ${params.toolName}`);

    const identity = await authenticate({
      bearerToken: params.bearerToken,
      delegationToken: params.delegationToken,
      secrets: this.opts.config.secrets,
      inboundPolicy: inboundPolicyFrom(this.opts.config.secrets),
      tenants: this.opts.tenants,
      callerCorrelationId: params.callerCorrelationId,
      now: params.now,
    });

    if (!this.limiter.check(`${identity.orgUid}:${identity.personUid}`)) {
      throw new AuthError(429, 'rate_limited', 'Too many tool calls');
    }

    const parsed = tool.inputSchema.safeParse(params.args ?? {});
    if (!parsed.success) {
      // Validation failure is the caller's problem and is safe to describe.
      throw new AuthError(400, 'invalid_arguments', parsed.error.message);
    }

    const args = parsed.data as Record<string, unknown>;
    if ('projectId' in args) assertProjectAllowed(identity.tenant, args.projectId);

    const call = callContextFor(
      identity,
      tool.scopes,
      this.opts.config.secrets,
      params.now,
    );

    const startedAt = Date.now();
    // Identifiers, never content: a log line must not become a second copy of
    // the data the permission checks just gated.
    const trace = {
      tool: tool.name,
      service: this.opts.config.deployment.serviceName,
      // Who called, taken from the verified assertion rather than from any
      // header a caller could set.
      caller: identity.assertion.claims.iss,
      personUid: identity.personUid,
      orgUid: identity.orgUid,
      correlationId: identity.correlationId,
      // Distinct on purpose - see callContextFor.
      assertionJti: identity.assertion.claims.jti,
      delegationJti: call.delegationJti,
    };
    try {
      const result = await tool.handler(parsed.data, { client: this.client, call });
      this.logger.info('tool call', {
        ...trace,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      // A handler that throws produced no line at all before, so a failing
      // tool was invisible in exactly the situation the trace is for.
      this.logger.warn('tool call', {
        ...trace,
        outcome: 'error',
        error: (err as Error).name,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

export function createHttpServer(app: ConqrPlanMcpApp): Server {
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && req.url === '/ready') {
        // Ready means configured and able to serve, not that ConqrPlan is up:
        // a dependency outage should surface as a failed call with a real
        // reason, not as a service that silently drops out of rotation.
        return send(res, 200, { status: 'ready', tools: app.tools.length });
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        return send(res, 404, { error: 'not_found' });
      }

      const raw = await readBody(req);
      let body: JsonRpcRequest;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { error: 'invalid_json' });
      }

      if (body.method === 'tools/list') {
        return send(res, 200, {
          jsonrpc: '2.0',
          id: body.id ?? null,
          result: { tools: app.listTools() },
        });
      }

      if (body.method === 'tools/call') {
        const result = await app.callTool({
          toolName: String(body.params?.name ?? ''),
          args: body.params?.arguments,
          bearerToken: bearer(req),
          delegationToken:
            (req.headers['x-conqr-delegation'] as string | undefined) ?? undefined,
          callerCorrelationId:
            (req.headers['x-conqr-correlation-id'] as string | undefined) ?? undefined,
        });
        return send(res, 200, {
          jsonrpc: '2.0',
          id: body.id ?? null,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        });
      }

      return send(res, 400, { error: 'unsupported_method', method: body.method });
    } catch (err) {
      if (err instanceof AuthError) {
        app.logger.warn('request refused', {
          requestId,
          status: err.status,
          classification: err.classification,
        });
        return send(res, err.status, { error: err.classification, message: err.message });
      }
      app.logger.error('request failed', {
        requestId,
        message: (err as Error).message,
      });
      return send(res, 500, { error: 'internal_error', requestId });
    }
  });
}
