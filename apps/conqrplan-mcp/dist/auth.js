"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthError = exports.MCP_AUDIENCE = void 0;
exports.isKnownClientToken = isKnownClientToken;
exports.authenticate = authenticate;
exports.callContextFor = callContextFor;
exports.assertProjectAllowed = assertProjectAllowed;
const node_crypto_1 = require("node:crypto");
const conqrplan_core_1 = require("@conqr/conqrplan-core");
/**
 * The trust chain, in one place.
 *
 *   authenticated client -> MCP service -> ConqrPlan authorization
 *
 * Two separate identities travel on every call and they answer different
 * questions. The bearer token says *which service* is calling. The delegation
 * says *which human* it is acting for. Neither substitutes for the other, and
 * the service never invents the second one.
 *
 * The delegation a client presents is addressed to this service
 * (aud: conqrplan-mcp). It is verified and then **exchanged** for a fresh
 * token addressed to ConqrPlan, carrying only the scopes the invoked tool
 * declares. It is never forwarded: a token being signed with a key we happen
 * to hold does not make it addressed to ConqrPlan, and passing it on would let
 * one audience's token act at another.
 *
 * There is no path here that produces an actor from a tool argument. A caller
 * that could name its own person_uid could act as anyone, which is exactly the
 * escalation the delegation contract exists to close.
 */
exports.MCP_AUDIENCE = 'conqrplan-mcp';
class AuthError extends Error {
    status;
    classification;
    constructor(status, classification, message) {
        super(message ?? classification.replace(/_/g, ' '));
        this.status = status;
        this.classification = classification;
    }
}
exports.AuthError = AuthError;
/** Constant-time membership test over sha256 digests of accepted tokens. */
function isKnownClientToken(token, hashes) {
    const digest = Buffer.from((0, node_crypto_1.createHash)('sha256').update(token).digest('hex'), 'utf8');
    let matched = false;
    for (const known of hashes) {
        const candidate = Buffer.from(known, 'utf8');
        if (candidate.length !== digest.length)
            continue;
        // No early exit: every configured hash is compared so the time taken does
        // not depend on which one matched, or how far down the list it was.
        if ((0, node_crypto_1.timingSafeEqual)(candidate, digest))
            matched = true;
    }
    return matched;
}
/**
 * Authenticate the client, establish the human actor, and resolve the tenant.
 *
 * Order matters: the transport identity is checked first so an unauthenticated
 * caller never reaches delegation verification, and the tenant is resolved
 * from the verified claim rather than from anything the caller asked for.
 */
async function authenticate(input) {
    if (!input.bearerToken) {
        throw new AuthError(401, 'client_unauthenticated', 'Missing bearer token');
    }
    if (!isKnownClientToken(input.bearerToken, input.secrets.clientTokenHashes)) {
        throw new AuthError(401, 'client_unauthenticated', 'Unrecognised bearer token');
    }
    let claims;
    try {
        claims = (0, conqrplan_core_1.verifyDelegation)(input.delegationToken, {
            signingKey: input.inboundSigningKey,
            issuer: input.secrets.oboIssuer,
            audience: exports.MCP_AUDIENCE,
            now: input.now,
        });
    }
    catch (err) {
        const classification = err instanceof conqrplan_core_1.DelegationError ? err.classification : 'delegation_invalid';
        // A client that authenticated but named no human gets 403, not 401: the
        // service knows who is calling, it just will not act for nobody.
        throw new AuthError(403, classification);
    }
    const tenant = await input.tenants.forOrgUid(claims.tid);
    if (!tenant) {
        // Fail closed. An unapproved tenant is refused, never guessed at.
        throw new AuthError(403, 'tenant_unmapped');
    }
    return {
        personUid: claims.sub,
        orgUid: claims.tid,
        tenant,
        correlationId: claims.jti,
    };
}
/**
 * Exchange the verified identity for a ConqrPlan call context.
 *
 * A fresh token per tool call, carrying only that tool's scopes and addressed
 * to ConqrPlan. ConqrPlan then makes the final membership and permission
 * decision against the named human - this service narrows what may be
 * attempted and grants nothing.
 */
function callContextFor(identity, scopes, secrets, now) {
    const minted = (0, conqrplan_core_1.mintDelegation)({
        personUid: identity.personUid,
        orgUid: identity.orgUid,
        scope: scopes,
        signingKey: secrets.oboSigningKey,
        issuer: secrets.oboIssuer,
        audience: secrets.oboAudience,
        now,
    });
    return {
        delegation: minted.token,
        correlationId: identity.correlationId,
        workspaceSlug: identity.tenant.workspaceSlug,
    };
}
/**
 * Check a requested project against the tenant's allow-list.
 *
 * A narrowing gate, not the authorization: ConqrPlan still decides whether the
 * acting human may touch the project. This only stops a request addressed at a
 * project the deployment never approved from being attempted at all.
 */
function assertProjectAllowed(tenant, projectId) {
    if (tenant.allowedProjectIds === null)
        return;
    if (typeof projectId !== 'string' || !tenant.allowedProjectIds.includes(projectId)) {
        throw new AuthError(403, 'project_not_approved');
    }
}
