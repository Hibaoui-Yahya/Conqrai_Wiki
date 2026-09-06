"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConqrPlanMcpApp = void 0;
exports.createLogger = createLogger;
exports.createHttpServer = createHttpServer;
const node_http_1 = require("node:http");
const node_crypto_1 = require("node:crypto");
const conqrplan_core_1 = require("@conqr/conqrplan-core");
const auth_1 = require("./auth");
/** Redacting console logger. Never logs a token, a delegation or a secret. */
function createLogger(level) {
    const order = ['debug', 'info', 'warn', 'error'];
    const min = Math.max(0, order.indexOf(level));
    const emit = (lvl, msg, meta) => {
        if (order.indexOf(lvl) < min)
            return;
        process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...meta }) + '\n');
    };
    return {
        info: (m, x) => emit('info', m, x),
        warn: (m, x) => emit('warn', m, x),
        error: (m, x) => emit('error', m, x),
    };
}
/** Fixed-window per-actor limiter. Bounded memory, swept on write. */
class RateLimiter {
    perMinute;
    hits = new Map();
    constructor(perMinute) {
        this.perMinute = perMinute;
    }
    check(key, now = Date.now()) {
        const windowStart = Math.floor(now / 60_000) * 60_000;
        const entry = this.hits.get(key);
        if (!entry || entry.windowStart !== windowStart) {
            if (this.hits.size > 10_000)
                this.hits.clear();
            this.hits.set(key, { windowStart, count: 1 });
            return true;
        }
        entry.count += 1;
        return entry.count <= this.perMinute;
    }
}
class ConqrPlanMcpApp {
    opts;
    tools;
    byName;
    client;
    limiter;
    logger;
    constructor(opts) {
        this.opts = opts;
        this.tools = opts.tools ?? conqrplan_core_1.CONQRPLAN_TOOLS;
        this.byName = new Map(this.tools.map((t) => [t.name, t]));
        this.logger = opts.logger ?? createLogger(opts.config.deployment.logLevel);
        this.limiter = new RateLimiter(opts.config.deployment.rateLimitPerMinute);
        this.client =
            opts.client ??
                new conqrplan_core_1.PlaneClient({
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
    async callTool(params) {
        const tool = this.byName.get(params.toolName);
        if (!tool)
            throw new auth_1.AuthError(404, 'unknown_tool', `Unknown tool: ${params.toolName}`);
        const identity = await (0, auth_1.authenticate)({
            bearerToken: params.bearerToken,
            delegationToken: params.delegationToken,
            secrets: this.opts.config.secrets,
            inboundSigningKey: this.opts.inboundSigningKey,
            tenants: this.opts.tenants,
            now: params.now,
        });
        if (!this.limiter.check(`${identity.orgUid}:${identity.personUid}`)) {
            throw new auth_1.AuthError(429, 'rate_limited', 'Too many tool calls');
        }
        const parsed = tool.inputSchema.safeParse(params.args ?? {});
        if (!parsed.success) {
            // Validation failure is the caller's problem and is safe to describe.
            throw new auth_1.AuthError(400, 'invalid_arguments', parsed.error.message);
        }
        const args = parsed.data;
        if ('projectId' in args)
            (0, auth_1.assertProjectAllowed)(identity.tenant, args.projectId);
        const call = (0, auth_1.callContextFor)(identity, tool.scopes, this.opts.config.secrets, params.now);
        const startedAt = Date.now();
        const result = await tool.handler(parsed.data, { client: this.client, call });
        this.logger.info('tool call', {
            tool: tool.name,
            // Identifiers, never content: a log line must not become a second copy
            // of the data the permission checks just gated.
            personUid: identity.personUid,
            orgUid: identity.orgUid,
            correlationId: identity.correlationId,
            durationMs: Date.now() - startedAt,
        });
        return result;
    }
}
exports.ConqrPlanMcpApp = ConqrPlanMcpApp;
// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 4_000_000)
                reject(new Error('payload too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}
function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}
function bearer(req) {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer '))
        return undefined;
    return header.slice(7).trim() || undefined;
}
function createHttpServer(app) {
    return (0, node_http_1.createServer)(async (req, res) => {
        const requestId = (0, node_crypto_1.randomUUID)();
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
            let body;
            try {
                body = JSON.parse(raw || '{}');
            }
            catch {
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
                    delegationToken: req.headers['x-conqr-delegation'] ?? undefined,
                });
                return send(res, 200, {
                    jsonrpc: '2.0',
                    id: body.id ?? null,
                    result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
                });
            }
            return send(res, 400, { error: 'unsupported_method', method: body.method });
        }
        catch (err) {
            if (err instanceof auth_1.AuthError) {
                app.logger.warn('request refused', {
                    requestId,
                    status: err.status,
                    classification: err.classification,
                });
                return send(res, err.status, { error: err.classification, message: err.message });
            }
            app.logger.error('request failed', {
                requestId,
                message: err.message,
            });
            return send(res, 500, { error: 'internal_error', requestId });
        }
    });
}
