import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DelegatedScope,
  DelegationError,
  exchangeDelegation,
  PlaneCallContext,
  Secrets,
  TenantMapping,
  TenantMappingProvider,
  VerifiedAssertion,
  VerifierPolicy,
  verifyAssertion,
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
 * (aud: conqrplan-mcp). It is verified against an issuer-pinned policy and
 * then **exchanged** for a fresh token addressed to ConqrPlan, signed with
 * this service's own Ed25519 private key and carrying only the scopes the
 * invoked tool declares, never outliving the assertion it derives from. It is
 * never forwarded: a signed token is not thereby addressed to ConqrPlan, and
 * passing it on would let one audience's token act at another.
 *
 * This service does not hold ConqrPlan's HMAC key. It could not mint a
 * ConqrPlan token without its own registered key pair, and rotating that key
 * out of ConqrPlan's registry revokes it without touching anyone else.
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
  /** The verified inbound assertion, carried so the exchange can narrow to it. */
  assertion: VerifiedAssertion;
}

export interface AuthenticateInput {
  bearerToken: string | undefined;
  delegationToken: string | undefined;
  secrets: Secrets;
  /** Issuer-pinned policy for assertions addressed to this service. */
  inboundPolicy: VerifierPolicy;
  tenants: TenantMappingProvider;
  /**
   * The caller's own correlation id, if it sent one.
   *
   * Without this the two products log different ids for the same call - the
   * caller's, and this service's fallback - and the audit trails cannot be
   * joined by id at all, which is the one thing a correlation id is for.
   */
  callerCorrelationId?: string;
  now?: number;
}

/**
 * A caller-supplied correlation id, or null if it is not safe to adopt.
 *
 * This value is attacker-controlled: it arrives in a header and ends up in
 * log lines and in an outbound header to ConqrPlan. A newline in a log line
 * forges a second log record, so the charset is an allow-list rather than an
 * escape, and the length is bounded. Anything else is dropped in favour of
 * the assertion's jti - a refusal here would turn a cosmetic header into a
 * failed tool call.
 */
export function safeCorrelationId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  // Length is checked on the raw value, before any normalisation, so a huge
  // header cannot be whittled down into an acceptable one.
  if (value.length < 1 || value.length > 128) return null;
  // Deliberately not trimmed. Trimming would silently accept a value that is
  // not what the caller sent, and " x " and "x" would log as the same id
  // while being different headers on the wire. The allow-list excludes every
  // space, tab, newline, carriage return and control character outright, so
  // header and log-record injection are impossible by construction rather
  // than by escaping.
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

/** Build the inbound policy from validated configuration. */
export function inboundPolicyFrom(secrets: Secrets): VerifierPolicy {
  return {
    audience: MCP_AUDIENCE,
    issuers: secrets.inboundIssuers as VerifierPolicy['issuers'],
  };
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

  let assertion: VerifiedAssertion;
  try {
    assertion = verifyAssertion(input.delegationToken, input.inboundPolicy, {
      now: input.now,
    });
  } catch (err) {
    const classification =
      err instanceof DelegationError ? err.classification : 'delegation_invalid';
    // A client that authenticated but named no human gets 403, not 401: the
    // service knows who is calling, it just will not act for nobody.
    throw new AuthError(403, classification);
  }

  const claims = assertion.claims;
  const tenant = await input.tenants.forOrgUid(claims.tid);
  if (!tenant) {
    // Fail closed. An unapproved tenant is refused, never guessed at.
    throw new AuthError(403, 'tenant_unmapped');
  }

  return {
    personUid: claims.sub,
    orgUid: claims.tid,
    tenant,
    // The caller's id when it sent a usable one, so both products' audit
    // trails carry the same value. The jti remains the fallback, and remains
    // what identifies the assertion itself.
    correlationId: safeCorrelationId(input.callerCorrelationId) ?? claims.jti,
    assertion,
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
): PlaneCallContext & { delegationJti: string } {
  const minted = exchangeDelegation({
    inbound: identity.assertion,
    toolScopes: scopes,
    audience: secrets.oboAudience,
    issuer: secrets.issuer,
    privateKeyPem: secrets.signingPrivateKeyPem,
    kid: secrets.signingKeyId,
    now,
  });
  return {
    delegation: minted.token,
    correlationId: identity.correlationId,
    workspaceSlug: identity.tenant.workspaceSlug,
    // Surfaced so the audit line can name the token it minted without ever
    // logging the token. Three identifiers answer three different questions -
    // which distributed operation (correlationId), which inbound assertion
    // (its jti), which downstream token (this one) - and collapsing them into
    // one value would destroy replay analysis on either token.
    delegationJti: minted.jti,
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
