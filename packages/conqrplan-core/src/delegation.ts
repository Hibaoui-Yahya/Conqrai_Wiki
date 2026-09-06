import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

/**
 * On-behalf-of delegation, framework-free.
 *
 * Byte-identical to the contract ConqrPlan already verifies. Nothing here is
 * new: it is the same header, the same claim names and the same signature
 * base as ConqrHub mints today, lifted out of Nest so a service that does not
 * run Hub can still speak it. If this drifts, every delegated call fails
 * closed - which is the safe direction, but it is still an outage.
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

export const PERSON_PREFIX = 'conqr:person:';
export const ORG_PREFIX = 'conqr:org:';

/** Bounded tolerance for clock drift, matching ConqrPlan's verifier. */
export const CLOCK_SKEW_SECONDS = 30;

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

export class DelegationError extends Error {
  constructor(
    readonly classification: string,
    message?: string,
  ) {
    super(message ?? classification.replace(/_/g, ' '));
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(segment: string): Buffer {
  const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(signingInput: string, key: string): string {
  return b64url(createHmac('sha256', key).update(signingInput).digest());
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
export const DEFAULT_TTL_SECONDS = 300;

export function mintDelegation(opts: MintOptions): MintedDelegation {
  if (!opts.personUid.startsWith(PERSON_PREFIX)) {
    throw new DelegationError('delegation_bad_subject', 'subject is not a person_uid');
  }
  if (!opts.orgUid.startsWith(ORG_PREFIX)) {
    throw new DelegationError('delegation_bad_tenant', 'tenant is not an org_uid');
  }
  if (!opts.scope.length) {
    // A token with no scope can attempt nothing useful and hides a caller bug.
    throw new DelegationError('delegation_bad_scope', 'no scope requested');
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const jti = randomUUID();

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'CONQR-OBO' }));
  const payload = b64url(
    JSON.stringify({
      sub: opts.personUid,
      tid: opts.orgUid,
      aud: opts.audience,
      scope: opts.scope,
      iat: now,
      nbf: now,
      exp: now + ttl,
      act: 'obo',
      iss: opts.issuer,
      jti,
    } satisfies DelegatedClaims),
  );
  const signature = sign(`${header}.${payload}`, opts.signingKey);

  return {
    token: `${header}.${payload}.${signature}`,
    jti,
    personUid: opts.personUid,
    orgUid: opts.orgUid,
    scope: opts.scope,
    expiresAt: now + ttl,
  };
}

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
export function verifyDelegation(
  token: string | undefined,
  opts: VerifyOptions,
): DelegatedClaims {
  if (!token) throw new DelegationError('delegation_missing');
  if (!opts.signingKey) throw new DelegationError('delegation_not_configured');

  const parts = token.split('.');
  if (parts.length !== 3) throw new DelegationError('delegation_malformed');
  const [header64, payload64, signature64] = parts;

  const expected = sign(`${header64}.${payload64}`, opts.signingKey);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature64, 'utf8');
  // Length is checked first because timingSafeEqual throws on a mismatch, but
  // a dummy compare still runs so the timing does not reveal the difference.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    throw new DelegationError('delegation_bad_signature');
  }
  if (!timingSafeEqual(a, b)) {
    throw new DelegationError('delegation_bad_signature');
  }

  let header: Record<string, unknown>;
  let claims: DelegatedClaims;
  try {
    header = JSON.parse(b64urlDecode(header64).toString('utf8'));
    claims = JSON.parse(b64urlDecode(payload64).toString('utf8'));
  } catch {
    throw new DelegationError('delegation_malformed');
  }

  if (header.typ !== 'CONQR-OBO' || header.alg !== 'HS256') {
    throw new DelegationError('delegation_bad_type');
  }
  if (claims.act !== 'obo') throw new DelegationError('delegation_not_obo');
  if (claims.iss !== opts.issuer) throw new DelegationError('delegation_wrong_issuer');
  // Audience is checked, never inferred. A token signed with a key this
  // service happens to hold is not thereby addressed to it.
  if (claims.aud !== opts.audience) {
    throw new DelegationError('delegation_wrong_audience');
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.nbf === 'number' && now + CLOCK_SKEW_SECONDS < claims.nbf) {
    throw new DelegationError('delegation_not_yet_valid');
  }
  if (typeof claims.exp !== 'number') throw new DelegationError('delegation_malformed');
  if (now - CLOCK_SKEW_SECONDS >= claims.exp) {
    throw new DelegationError('delegation_expired');
  }

  if (typeof claims.sub !== 'string' || !claims.sub.startsWith(PERSON_PREFIX)) {
    throw new DelegationError('delegation_bad_subject');
  }
  if (typeof claims.tid !== 'string' || !claims.tid.startsWith(ORG_PREFIX)) {
    throw new DelegationError('delegation_bad_tenant');
  }
  if (!claims.jti) throw new DelegationError('delegation_missing_jti');

  if (!Array.isArray(claims.scope) || !claims.scope.every((s) => typeof s === 'string')) {
    throw new DelegationError('delegation_bad_scope');
  }
  if (opts.requiredScope && !claims.scope.includes(opts.requiredScope)) {
    throw new DelegationError('delegation_insufficient_scope');
  }

  return claims;
}
