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
export declare const deploymentConfigSchema: z.ZodObject<{
    apiBaseUrl: z.ZodString;
    port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    requestTimeoutMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    maxConcurrency: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    rateLimitPerMinute: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    logLevel: z.ZodDefault<z.ZodEnum<{
        error: "error";
        debug: "debug";
        info: "info";
        warn: "warn";
    }>>;
    serviceName: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
/**
 * One approved tenant.
 *
 * orgUid is the canonical suite identifier and is never regenerated here. It
 * is derived from ConqrHub's workspace id and must survive extraction
 * unchanged, or every identity mapping already provisioned in ConqrPlan stops
 * matching and every delegated call fails closed.
 */
export declare const tenantMappingSchema: z.ZodObject<{
    orgUid: z.ZodString;
    workspaceSlug: z.ZodString;
    allowedProjectIds: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
}, z.core.$strip>;
export type TenantMapping = z.infer<typeof tenantMappingSchema>;
export declare const organizationConfigSchema: z.ZodObject<{
    tenants: z.ZodArray<z.ZodObject<{
        orgUid: z.ZodString;
        workspaceSlug: z.ZodString;
        allowedProjectIds: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type OrganizationConfig = z.infer<typeof organizationConfigSchema>;
export declare const secretsSchema: z.ZodObject<{
    planeApiKey: z.ZodString;
    oboSigningKey: z.ZodString;
    oboIssuer: z.ZodDefault<z.ZodString>;
    oboAudience: z.ZodDefault<z.ZodString>;
    clientTokenHashes: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type Secrets = z.infer<typeof secretsSchema>;
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
export declare class StaticTenantMappingProvider implements TenantMappingProvider {
    private readonly byOrgUid;
    constructor(config: OrganizationConfig);
    forOrgUid(orgUid: string): Promise<TenantMapping | null>;
    all(): Promise<TenantMapping[]>;
}
export declare class ConfigError extends Error {
}
/**
 * Build the service configuration from the environment.
 *
 * Throws on anything missing or malformed rather than starting in a state
 * that fails later, per request, in a way that reads like a permissions bug.
 */
export declare function loadServiceConfig(env?: NodeJS.ProcessEnv): ServiceConfig;
/** Parse CONQRPLAN_TENANTS (JSON array) into a validated static provider. */
export declare function loadStaticTenants(env?: NodeJS.ProcessEnv): StaticTenantMappingProvider;
//# sourceMappingURL=config.d.ts.map