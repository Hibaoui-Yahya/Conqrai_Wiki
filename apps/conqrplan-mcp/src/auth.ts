import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DelegatedScope,
  DelegationError,
  mintDelegation,
  PlaneCallContext,
  Secrets,
  TenantMapping,
  TenantMappingProvider,
  verifyDelegation,
} from '@conqr/conqrplan-core';

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

export const MCP_AUDIENCE = 'conqrplan-mcp';

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly classification: string,
    message?: string,
  ) {
    super(message ?? classification.replace(/_/g, ' '));
  }
}

/** Constant-time membership test over sha256 digests of accepted tokens. */
export function isKnownClientToken(token: string, hashes: string[]): boolean {
  const digest = Buffer.from(createHash('sha256').update(token).digest('hex'), 'utf8');
  let matched = false;
  for (const known of hashes) {
    const candidate = Buffer.from(known, 'utf8');
    if (candidate.length !== digest.length) continue;
    // No early exit: every configured hash is compared so the time taken does
    // not depend on which one matched, or how far down the list it was.
    if (timingSafeEqual(candidate, digest)) matched = true;
  }
  return matched;
}

export interface RequestIdentity {
  /** Canonical person_uid of the human this call acts for. */
  personUid: string;
  /** Canonical org_uid, taken from the delegation and never from an argument. */
  orgUid: string;
  tenant: TenantMapping;
  /** Correlates the whole exchange across both products' audit trails. */
  correlationId: string;
}

export interface AuthenticateInput {
  bearerToken: string | undefined;
  delegationToken: string | undefined;
  secrets: Secrets;
  /** Key the client-facing delegation is signed with. */
  inboundSigningKey: string;
  tenants: TenantMappingProvider;
  now?: number;
}

/**
 * Authenticate the client, establish the human actor, and resolve the tenant.
 *
 * Order matters: the transport identity is checked first so an unauthenticated
 * caller never reaches delegation verification, and the tenant is resolved
 * from the verified claim rather than from anything the caller asked for.
 */
export async function authenticate(
  input: AuthenticateInput,
): Promise<RequestIdentity> {
  if (!input.bearerToken) {
    throw new AuthError(401, 'client_unauthenticated', 'Missing bearer token');
  }
  if (!isKnownClientToken(input.bearerToken, input.secrets.clientTokenHashes)) {
    throw new AuthError(401, 'client_unauthenticated', 'Unrecognised bearer token');
  }

  let claims;
  try {
    claims = verifyDelegation(input.delegationToken, {
      signingKey: input.inboundSigningKey,
      issuer: input.secrets.oboIssuer,
      audience: MCP_AUDIENCE,
      now: input.now,
    });
  } catch (err) {
    const classification =
      err instanceof DelegationError ? err.classification : 'delegation_invalid';
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
export function callContextFor(
  identity: RequestIdentity,
  scopes: DelegatedScope[],
  secrets: Secrets,
  now?: number,
): PlaneCallContext {
  const minted = mintDelegation({
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
export function assertProjectAllowed(tenant: TenantMapping, projectId: unknown): void {
  if (tenant.allowedProjectIds === null) return;
  if (typeof projectId !== 'string' || !tenant.allowedProjectIds.includes(projectId)) {
    throw new AuthError(403, 'project_not_approved');
  }
}
