import { z } from 'zod';

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

export const deploymentConfigSchema = z.object({
  /** ConqrPlan REST base, e.g. https://plan.example.com/api/v1 */
  apiBaseUrl: z.string().url(),
  /** Port the MCP service listens on. */
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Per-request timeout against ConqrPlan, milliseconds. */
  requestTimeoutMs: z.coerce.number().int().min(1000).max(120000).default(30000),
  /** Max ConqrPlan requests in flight across all callers. */
  maxConcurrency: z.coerce.number().int().min(1).max(256).default(16),
  /** Per-actor tool calls per minute. */
  rateLimitPerMinute: z.coerce.number().int().min(1).max(10000).default(120),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Recorded as the calling service in ConqrPlan's delegation audit. */
  serviceName: z.string().min(1).default('conqrplan-mcp'),
});
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

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
export const tenantMappingSchema = z.object({
  orgUid: z.string().regex(/^conqr:org:/, 'must be a canonical org_uid'),
  workspaceSlug: z.string().min(1),
  /**
   * Projects this tenant may address, or null for "any project the acting
   * human can see". null is not the weaker option: ConqrPlan authorises every
   * request against that human's own project membership either way. The list
   * is a second, narrower gate for deployments that want one.
   */
  allowedProjectIds: z.array(z.string().uuid()).nullable().default(null),
});
export type TenantMapping = z.infer<typeof tenantMappingSchema>;

export const organizationConfigSchema = z.object({
  tenants: z.array(tenantMappingSchema).min(1),
});
export type OrganizationConfig = z.infer<typeof organizationConfigSchema>;

// ---------------------------------------------------------------------------
// 3. Secrets
// ---------------------------------------------------------------------------

export const secretsSchema = z.object({
  /**
   * The ConqrPlan bot token. Transport identity only: it says which service
   * is calling and never becomes a human actor. ConqrPlan refuses it outright
   * on a delegated endpoint that carries no valid delegation.
   */
  planeApiKey: z.string().min(1),
  /**
   * This service's own Ed25519 private key, PEM (PKCS#8).
   *
   * Deliberately not ConqrPlan's HMAC key. A shared secret makes every holder
   * an issuer, so holding ConqrPlan's would let this service mint anything
   * ConqrPlan accepts. The private half stays here; ConqrPlan registers only
   * the public half.
   */
  signingPrivateKeyPem: z.string().includes('PRIVATE KEY'),
  /** Key id ConqrPlan registers this key under. A selector, never a URL. */
  signingKeyId: z.string().min(1),
  /** Issuer name this service signs as. */
  issuer: z.string().min(1).default('conqrplan-mcp'),
  oboAudience: z.string().min(1).default('conqrplan'),
  /**
   * Issuers this service accepts assertions from, as JSON:
   *   {"<issuer>": {"algorithm": "EdDSA", "publicKeys": {"<kid>": "<PEM>"},
   *                 "allowedScopes": [...], "maxTtlSeconds": 300}}
   * An HS256 issuer carries "hmacKey" instead, for the migration window.
   */
  inboundIssuers: z.record(z.any()),
  /**
   * Bearer tokens accepted from MCP clients, as sha256 hex digests. Digests
   * rather than the tokens themselves, so a config dump or a log line leaks
   * nothing usable.
   */
  clientTokenHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
});
export type Secrets = z.infer<typeof secretsSchema>;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ServiceConfig {
  deployment: DeploymentConfig;
  secrets: Secrets;
}

/**
 * Where approved tenant mappings come from.
 *
 * An interface, because the authority for mappings has to live in exactly one
 * place. Today that is ConqrHub, which already stores project-to-space
 * mappings; copying them into a second database would create two answers to
 * one question and no way to tell which had gone stale. A deployment without
 * Hub uses the static provider instead.
 */
export interface TenantMappingProvider {
  /** The tenant for a canonical org_uid, or null when it is not approved. */
  forOrgUid(orgUid: string): Promise<TenantMapping | null>;
  /** Everything approved, for startup validation and health reporting. */
  all(): Promise<TenantMapping[]>;
}

/** Validated, in-memory mappings. The standalone deployment path. */
export class StaticTenantMappingProvider implements TenantMappingProvider {
  private readonly byOrgUid: Map<string, TenantMapping>;

  constructor(config: OrganizationConfig) {
    const parsed = organizationConfigSchema.parse(config);
    this.byOrgUid = new Map(parsed.tenants.map((t) => [t.orgUid, t]));
    if (this.byOrgUid.size !== parsed.tenants.length) {
      throw new Error('Duplicate orgUid in organization configuration');
    }
  }

  async forOrgUid(orgUid: string): Promise<TenantMapping | null> {
    return this.byOrgUid.get(orgUid) ?? null;
  }

  async all(): Promise<TenantMapping[]> {
    return Array.from(this.byOrgUid.values());
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
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
function parseInboundIssuers(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('CONQRPLAN_MCP_INBOUND_ISSUERS is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('CONQRPLAN_MCP_INBOUND_ISSUERS must be an object');
  }
  const issuers = parsed as Record<string, { algorithm?: unknown }>;
  if (!Object.keys(issuers).length) {
    // No trusted issuer means no request can ever name a human, so the
    // service would start and refuse everything. Fail here instead.
    throw new ConfigError('CONQRPLAN_MCP_INBOUND_ISSUERS declares no issuer');
  }
  for (const [name, policy] of Object.entries(issuers)) {
    if (policy?.algorithm !== 'EdDSA' && policy?.algorithm !== 'HS256') {
      throw new ConfigError(`Issuer ${name} must pin algorithm EdDSA or HS256`);
    }
  }
  return issuers;
}

export function loadServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const deployment = deploymentConfigSchema.safeParse({
    apiBaseUrl: required(env, 'CONQRPLAN_API_URL'),
    port: env.PORT,
    requestTimeoutMs: env.CONQRPLAN_REQUEST_TIMEOUT_MS,
    maxConcurrency: env.CONQRPLAN_MAX_CONCURRENCY,
    rateLimitPerMinute: env.CONQRPLAN_RATE_LIMIT_PER_MINUTE,
    logLevel: env.LOG_LEVEL,
    serviceName: env.CONQRPLAN_SERVICE_NAME,
  });
  if (!deployment.success) {
    throw new ConfigError(
      `Invalid deployment configuration: ${deployment.error.message}`,
    );
  }

  const secrets = secretsSchema.safeParse({
    planeApiKey: required(env, 'CONQRPLAN_API_KEY'),
    signingPrivateKeyPem: required(env, 'CONQRPLAN_MCP_PRIVATE_KEY_PEM'),
    signingKeyId: required(env, 'CONQRPLAN_MCP_KEY_ID'),
    issuer: env.CONQRPLAN_MCP_ISSUER,
    oboAudience: env.CONQR_OBO_AUDIENCE,
    inboundIssuers: parseInboundIssuers(required(env, 'CONQRPLAN_MCP_INBOUND_ISSUERS')),
    clientTokenHashes: (env.CONQRPLAN_MCP_CLIENT_TOKEN_SHA256 ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  });
  if (!secrets.success) {
    throw new ConfigError(
      `Invalid secret configuration: ${secrets.error.message}`,
    );
  }

  return { deployment: deployment.data, secrets: secrets.data };
}

/** Parse CONQRPLAN_TENANTS (JSON array) into a validated static provider. */
export function loadStaticTenants(
  env: NodeJS.ProcessEnv = process.env,
): StaticTenantMappingProvider {
  const raw = required(env, 'CONQRPLAN_TENANTS');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('CONQRPLAN_TENANTS is not valid JSON');
  }
  const result = organizationConfigSchema.safeParse({ tenants: parsed });
  if (!result.success) {
    throw new ConfigError(`Invalid CONQRPLAN_TENANTS: ${result.error.message}`);
  }
  return new StaticTenantMappingProvider(result.data);
}
