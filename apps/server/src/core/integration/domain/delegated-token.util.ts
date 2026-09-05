import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isOrgUid, isPersonUid } from './canonical-identity.util';

/**
 * On-behalf-of / delegated authorization tokens (blueprint §9.1).
 *
 * User-initiated cross-product operations must preserve the acting user's
 * identity — never a single all-powerful integration bot. These are
 * short-lived, audience-bound, least-privilege tokens carrying the acting
 * human (`sub`), the tenant (`tid`), explicit scopes, an issuer and a unique
 * `jti` that doubles as the correlation id.
 *
 * Two credentials travel together on a delegated request and they answer
 * different questions:
 *
 *   X-Api-Key           which *service* is calling (transport identity)
 *   X-Conqr-Delegation  which *human* the service is acting for (this token)
 *
 * The API key alone must never become the human actor. That is exactly the
 * defect this contract closes: ConqrPlan previously authorised every write as
 * the API key's owner while an unsigned `X-Conqr-On-Behalf-Of` header was
 * ignored.
 *
 * Signing is HMAC-SHA256 over base64url(header).base64url(payload), with a key
 * dedicated to delegation rather than the ConqrHub app secret — see
 * EnvironmentService.getDelegationSigningKey(). The suite has no JWKS or
 * asymmetric signing infrastructure, so introducing one here would create a
 * second, incompatible identity system; key separation gets the property that
 * matters (ConqrPlan cannot mint ConqrHub sessions) without that.
 *
 * Compact format, no external dependency:
 *   base64url(header).base64url(payload).signature
 */

/**
 * Delegated scopes. One per operation class, least privilege: a token minted
 * to read work items cannot create one, and none of them can configure
 * estimation. ConqrPlan checks the scope *and then* the user's own local
 * permission — the scope narrows what the delegation may attempt, it never
 * grants anything the human cannot already do.
 */
export const DELEGATED_SCOPES = {
  workItemRead: 'work-item:read',
  workItemCreate: 'work-item:create',
  workItemUpdate: 'work-item:update',
  workItemBulkCreate: 'work-item:bulk-create',
  estimateRead: 'estimate:read',
  estimateConfigure: 'estimate:configure',
  cycleAssign: 'cycle:assign',
  moduleAssign: 'module:assign',
} as const;

export type DelegatedScope =
  (typeof DELEGATED_SCOPES)[keyof typeof DELEGATED_SCOPES];

/** Audience value for ConqrPlan. */
export const CONQRPLAN_AUDIENCE = 'conqrplan';

export interface DelegatedClaims {
  /** Subject — canonical `person_uid` of the acting human. */
  sub: string;
  /** Tenant — canonical `org_uid` the action is scoped to. */
  tid: string;
  /** Audience — the target product/service, e.g. "conqrplan". */
  aud: string;
  /** Least-privilege scopes, e.g. ["work-item:create"]. */
  scope: string[];
  /** Issued-at / expiry (epoch seconds). */
  iat: number;
  exp: number;
  /** Marks this as an on-behalf-of delegation, not a raw user session. */
  act: 'obo';
  /** Issuer — which service minted this delegation. */
  iss: string;
  /** Unique token id. Doubles as the correlation id for the whole exchange. */
  jti: string;
  /**
   * Not-before (epoch seconds). Present so a verifier can reject a token
   * minted with a skewed clock rather than trusting `iat` alone.
   */
  nbf: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'CONQR-OBO' }));

export function mintDelegatedToken(
  params: {
    /** Canonical person_uid. A raw row id is refused. */
    sub: string;
    /** Canonical org_uid. A raw row id is refused. */
    tid: string;
    aud: string;
    scope: string[];
    ttlSeconds: number;
    nowSeconds: number;
    issuer: string;
    /** Supplied only by tests; production mints a fresh id per token. */
    jti?: string;
  },
  secret: string,
): string {
  if (!secret) throw new Error('Signing key required to mint delegated token');
  // Refuse to mint a delegation naming something that is not a canonical
  // identity. A raw ConqrHub row id here would be meaningless to the verifier
  // and is the shape the pre-delegation header used to carry.
  if (!isPersonUid(params.sub)) {
    throw new Error('Delegated token subject must be a canonical person_uid');
  }
  if (!isOrgUid(params.tid)) {
    throw new Error('Delegated token tenant must be a canonical org_uid');
  }
  if (!params.issuer) throw new Error('Delegated token issuer is required');
  if (!params.scope?.length) {
    throw new Error('Delegated token requires at least one scope');
  }
  const claims: DelegatedClaims = {
    sub: params.sub,
    tid: params.tid,
    aud: params.aud,
    scope: params.scope,
    iat: params.nowSeconds,
    nbf: params.nowSeconds,
    exp: params.nowSeconds + Math.max(1, params.ttlSeconds),
    act: 'obo',
    iss: params.issuer,
    jti: params.jti ?? randomUUID(),
  };
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${HEADER}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export interface VerifyOptions {
  audience: string;
  requiredScope?: string;
  nowSeconds: number;
  /** When set, the token's `iss` must match exactly. */
  issuer?: string;
  /** Tolerance in seconds for clock skew on nbf/exp. Defaults to 0. */
  clockSkewSeconds?: number;
}

export type VerifyResult =
  | { ok: true; claims: DelegatedClaims }
  | { ok: false; reason: string };

export function verifyDelegatedToken(
  token: string | undefined,
  opts: VerifyOptions,
  secret: string,
): VerifyResult {
  if (!token || !secret) return { ok: false, reason: 'missing_token_or_secret' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, sig] = parts;

  const expected = b64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: DelegatedClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString());
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }

  if (claims.act !== 'obo') return { ok: false, reason: 'not_delegated' };
  if (opts.issuer && claims.iss !== opts.issuer) {
    return { ok: false, reason: 'wrong_issuer' };
  }
  if (claims.aud !== opts.audience) return { ok: false, reason: 'wrong_audience' };

  const skew = opts.clockSkewSeconds ?? 0;
  if (typeof claims.nbf === 'number' && opts.nowSeconds + skew < claims.nbf) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (opts.nowSeconds - skew >= claims.exp) return { ok: false, reason: 'expired' };

  // Identity claims must be canonical. Without this a token carrying a bare
  // row id would pass signature checks and reach the mapping layer.
  if (!isPersonUid(claims.sub)) return { ok: false, reason: 'bad_subject' };
  if (!isOrgUid(claims.tid)) return { ok: false, reason: 'bad_tenant' };
  if (!claims.jti) return { ok: false, reason: 'missing_jti' };

  if (!Array.isArray(claims.scope)) return { ok: false, reason: 'bad_scope' };
  if (opts.requiredScope && !claims.scope.includes(opts.requiredScope)) {
    return { ok: false, reason: 'insufficient_scope' };
  }
  return { ok: true, claims };
}
