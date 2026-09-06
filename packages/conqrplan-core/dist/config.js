"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigError = exports.StaticTenantMappingProvider = exports.secretsSchema = exports.organizationConfigSchema = exports.tenantMappingSchema = exports.deploymentConfigSchema = void 0;
exports.loadServiceConfig = loadServiceConfig;
exports.loadStaticTenants = loadStaticTenants;
const zod_1 = require("zod");
/**
 * Configuration, split by who owns each part.
 *
 * The four kinds below have different owners, change at different rates and
 * carry different risk, and the previous arrangement blurred them: a single
 * PLANE_WORKSPACE_SLUG decided tenant routing for every caller, which is only
 * correct while there is exactly one tenant. Keeping them apart is what lets
 * the service be deployed for another organisation without editing code, and
 * what stops a caller talking its way into another tenant.
 *
 *  1. Deployment   - endpoints, ports, timeouts, transport, logging.
 *  2. Organization - which tenants, workspaces and projects are approved.
 *  3. Secrets      - the bridge credential and the delegation trust material.
 *  4. Product      - states, estimates, cycles, modules. Deliberately absent:
 *                    ConqrPlan owns those and is the only place they exist.
 */
// ---------------------------------------------------------------------------
// 1. Deployment
// ---------------------------------------------------------------------------
exports.deploymentConfigSchema = zod_1.z.object({
    /** ConqrPlan REST base, e.g. https://plan.example.com/api/v1 */
    apiBaseUrl: zod_1.z.string().url(),
    /** Port the MCP service listens on. */
    port: zod_1.z.coerce.number().int().min(1).max(65535).default(8080),
    /** Per-request timeout against ConqrPlan, milliseconds. */
    requestTimeoutMs: zod_1.z.coerce.number().int().min(1000).max(120000).default(30000),
    /** Max ConqrPlan requests in flight across all callers. */
    maxConcurrency: zod_1.z.coerce.number().int().min(1).max(256).default(16),
    /** Per-actor tool calls per minute. */
    rateLimitPerMinute: zod_1.z.coerce.number().int().min(1).max(10000).default(120),
    logLevel: zod_1.z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** Recorded as the calling service in ConqrPlan's delegation audit. */
    serviceName: zod_1.z.string().min(1).default('conqrplan-mcp'),
});
// ---------------------------------------------------------------------------
// 2. Organization
// ---------------------------------------------------------------------------
/**
 * One approved tenant.
 *
 * orgUid is the canonical suite identifier and is never regenerated here. It
 * is derived from ConqrHub's workspace id and must survive extraction
 * unchanged, or every identity mapping already provisioned in ConqrPlan stops
 * matching and every delegated call fails closed.
 */
exports.tenantMappingSchema = zod_1.z.object({
    orgUid: zod_1.z.string().regex(/^conqr:org:/, 'must be a canonical org_uid'),
    workspaceSlug: zod_1.z.string().min(1),
    /**
     * Projects this tenant may address, or null for "any project the acting
     * human can see". null is not the weaker option: ConqrPlan authorises every
     * request against that human's own project membership either way. The list
     * is a second, narrower gate for deployments that want one.
     */
    allowedProjectIds: zod_1.z.array(zod_1.z.string().uuid()).nullable().default(null),
});
exports.organizationConfigSchema = zod_1.z.object({
    tenants: zod_1.z.array(exports.tenantMappingSchema).min(1),
});
// ---------------------------------------------------------------------------
// 3. Secrets
// ---------------------------------------------------------------------------
exports.secretsSchema = zod_1.z.object({
    /**
     * The ConqrPlan bot token. Transport identity only: it says which service
     * is calling and never becomes a human actor. ConqrPlan refuses it outright
     * on a delegated endpoint that carries no valid delegation.
     */
    planeApiKey: zod_1.z.string().min(1),
    /** Key the delegation is signed with. Never ConqrHub's APP_SECRET. */
    oboSigningKey: zod_1.z.string().min(32, 'signing key is too short to be safe'),
    oboIssuer: zod_1.z.string().min(1).default('conqrhub'),
    oboAudience: zod_1.z.string().min(1).default('conqrplan'),
    /**
     * Bearer tokens accepted from MCP clients, as sha256 hex digests. Digests
     * rather than the tokens themselves, so a config dump or a log line leaks
     * nothing usable.
     */
    clientTokenHashes: zod_1.z.array(zod_1.z.string().regex(/^[a-f0-9]{64}$/)).min(1),
});
/** Validated, in-memory mappings. The standalone deployment path. */
class StaticTenantMappingProvider {
    byOrgUid;
    constructor(config) {
        const parsed = exports.organizationConfigSchema.parse(config);
        this.byOrgUid = new Map(parsed.tenants.map((t) => [t.orgUid, t]));
        if (this.byOrgUid.size !== parsed.tenants.length) {
            throw new Error('Duplicate orgUid in organization configuration');
        }
    }
    async forOrgUid(orgUid) {
        return this.byOrgUid.get(orgUid) ?? null;
    }
    async all() {
        return Array.from(this.byOrgUid.values());
    }
}
exports.StaticTenantMappingProvider = StaticTenantMappingProvider;
// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
class ConfigError extends Error {
}
exports.ConfigError = ConfigError;
function required(env, key) {
    const value = env[key];
    if (!value || !value.trim()) {
        // Naming the variable is the point. A service that dies saying "invalid
        // configuration" costs an operator an hour.
        throw new ConfigError(`Missing required configuration: ${key}`);
    }
    return value.trim();
}
/**
 * Build the service configuration from the environment.
 *
 * Throws on anything missing or malformed rather than starting in a state
 * that fails later, per request, in a way that reads like a permissions bug.
 */
function loadServiceConfig(env = process.env) {
    const deployment = exports.deploymentConfigSchema.safeParse({
        apiBaseUrl: required(env, 'CONQRPLAN_API_URL'),
        port: env.PORT,
        requestTimeoutMs: env.CONQRPLAN_REQUEST_TIMEOUT_MS,
        maxConcurrency: env.CONQRPLAN_MAX_CONCURRENCY,
        rateLimitPerMinute: env.CONQRPLAN_RATE_LIMIT_PER_MINUTE,
        logLevel: env.LOG_LEVEL,
        serviceName: env.CONQRPLAN_SERVICE_NAME,
    });
    if (!deployment.success) {
        throw new ConfigError(`Invalid deployment configuration: ${deployment.error.message}`);
    }
    const secrets = exports.secretsSchema.safeParse({
        planeApiKey: required(env, 'CONQRPLAN_API_KEY'),
        oboSigningKey: required(env, 'CONQR_OBO_SIGNING_KEY'),
        oboIssuer: env.CONQR_OBO_ISSUER,
        oboAudience: env.CONQR_OBO_AUDIENCE,
        clientTokenHashes: (env.CONQRPLAN_MCP_CLIENT_TOKEN_SHA256 ?? '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    });
    if (!secrets.success) {
        throw new ConfigError(`Invalid secret configuration: ${secrets.error.message}`);
    }
    return { deployment: deployment.data, secrets: secrets.data };
}
/** Parse CONQRPLAN_TENANTS (JSON array) into a validated static provider. */
function loadStaticTenants(env = process.env) {
    const raw = required(env, 'CONQRPLAN_TENANTS');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new ConfigError('CONQRPLAN_TENANTS is not valid JSON');
    }
    const result = exports.organizationConfigSchema.safeParse({ tenants: parsed });
    if (!result.success) {
        throw new ConfigError(`Invalid CONQRPLAN_TENANTS: ${result.error.message}`);
    }
    return new StaticTenantMappingProvider(result.data);
}
