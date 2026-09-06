/**
 * On-behalf-of delegation, framework-free.
 *
 * Byte-identical to the contract ConqrPlan already verifies. Nothing here is
 * new: it is the same header, the same claim names and the same signature
 * base as ConqrHub mints today, lifted out of Nest so a service that does not
 * run Hub can still speak it. If this drifts, every delegated call fails
 * closed - which is the safe direction, but it is still an outage.
 */
export declare const DELEGATED_SCOPES: {
    readonly workItemRead: "work-item:read";
    readonly workItemCreate: "work-item:create";
    readonly workItemUpdate: "work-item:update";
    readonly workItemBulkCreate: "work-item:bulk-create";
    readonly estimateRead: "estimate:read";
    readonly estimateConfigure: "estimate:configure";
    readonly cycleAssign: "cycle:assign";
    readonly moduleAssign: "module:assign";
};
export type DelegatedScope = (typeof DELEGATED_SCOPES)[keyof typeof DELEGATED_SCOPES];
export declare const PERSON_PREFIX = "conqr:person:";
export declare const ORG_PREFIX = "conqr:org:";
/** Bounded tolerance for clock drift, matching ConqrPlan's verifier. */
export declare const CLOCK_SKEW_SECONDS = 30;
export interface DelegatedClaims {
    sub: string;
    tid: string;
    aud: string;
    scope: string[];
    iat: number;
    nbf: number;
    exp: number;
    act: 'obo';
    iss: string;
    jti: string;
}
export interface MintedDelegation {
    token: string;
    jti: string;
    personUid: string;
    orgUid: string;
    scope: DelegatedScope[];
    expiresAt: number;
}
export declare class DelegationError extends Error {
    readonly classification: string;
    constructor(classification: string, message?: string);
}
export interface MintOptions {
    personUid: string;
    orgUid: string;
    scope: DelegatedScope[];
    signingKey: string;
    issuer: string;
    audience: string;
    ttlSeconds?: number;
    now?: number;
}
/** Default life. Short: a captured token is replayable until it expires. */
export declare const DEFAULT_TTL_SECONDS = 300;
export declare function mintDelegation(opts: MintOptions): MintedDelegation;
export interface VerifyOptions {
    signingKey: string;
    issuer: string;
    audience: string;
    requiredScope?: string;
    now?: number;
}
/**
 * Verify a delegation and return its claims.
 *
 * Every failure raises with a stable classification. There is deliberately no
 * partial success and no default identity: a fallback would turn a
 * verification bug into a silent privilege escalation.
 */
export declare function verifyDelegation(token: string | undefined, opts: VerifyOptions): DelegatedClaims;
//# sourceMappingURL=delegation.d.ts.map