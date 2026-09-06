import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from 'node:crypto';
import {
  CLOCK_SKEW_SECONDS,
  DelegatedClaims,
  DelegatedScope,
  DelegationError,
  ORG_PREFIX,
  PERSON_PREFIX,
} from './delegation';

/**
 * Issuer-pinned delegation trust.
 *
 * The extracted service must not hold ConqrPlan's HMAC key. With a shared
 * secret every holder is both verifier and issuer, so handing it to a second
 * service makes that service able to mint anything ConqrPlan accepts. Ed25519
 * separates those roles: each issuer keeps a private key nobody else has, and
 * verifiers hold only public keys.
 *
 * What that does *not* do is worth stating plainly. A service whose public key
 * is registered is a trusted issuer, and a trusted issuer can assert any
 * identity within its policy. Asymmetric signing means a compromise is
 * contained to that issuer and is attributable to it - not that a compromised
 * issuer is harmless. The limits that actually bound it are enforced here and
 * in ConqrPlan: pinned algorithm per issuer, pinned audience, a scope ceiling,
 * a lifetime ceiling, and ConqrPlan's own membership check on the named human.
 *
 * Algorithm confusion is closed by construction: the algorithm comes from the
 * issuer's policy, and a token whose header disagrees is refused before any
 * key is touched. The HMAC path reads only `hmacKey`, so public-key bytes can
 * never be used as a shared secret.
 */

export type SignatureAlgorithm = 'HS256' | 'EdDSA';

export interface IssuerPolicy {
  /** Value that must appear in the token's `iss`. */
  issuer: string;
  /** The one algorithm accepted from this issuer. Not read from the token. */
  algorithm: SignatureAlgorithm;
  /** HS256 only: the shared secret. Never populated for an EdDSA issuer. */
  hmacKey?: string;
  /**
   * EdDSA only: key id to public key (SPKI PEM). `kid` selects within this
   * registry and nothing else - it is never a URL, a path, or a hint to go
   * and fetch anything.
   */
  publicKeys?: Record<string, string>;
  /** Ceiling on what this issuer may assert. Absent means no extra ceiling. */
  allowedScopes?: string[];
  /** Ceiling on the lifetime of anything derived from this issuer. */
  maxTtlSeconds?: number;
}

export interface VerifierPolicy {
  /** The audience this verifier answers to. */
  audience: string;
  issuers: Record<string, IssuerPolicy>;
}

export interface VerifiedAssertion {
  claims: DelegatedClaims;
  policy: IssuerPolicy;
  /** Key id that verified it, for audit. Null for HMAC issuers. */
  kid: string | null;
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

function parseSegment(segment: string): Record<string, any> {
  try {
    return JSON.parse(b64urlDecode(segment).toString('utf8'));
  } catch {
    throw new DelegationError('delegation_malformed');
  }
}

/**
 * Verify an assertion against a pinned policy.
 *
 * `iss` is read before the signature purely to select which policy applies.
 * That is safe because the signature then binds it: a token naming an issuer
 * it was not signed by fails, and a token naming an unknown issuer is refused
 * without any key being consulted.
 */
export function verifyAssertion(
  token: string | undefined,
  policy: VerifierPolicy,
  opts: { requiredScope?: string; now?: number } = {},
): VerifiedAssertion {
  if (!token) throw new DelegationError('delegation_missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new DelegationError('delegation_malformed');
  const [header64, payload64, signature64] = parts;

  const header = parseSegment(header64);
  const claims = parseSegment(payload64) as DelegatedClaims;

  const issuerPolicy = policy.issuers[claims.iss];
  if (!issuerPolicy) throw new DelegationError('delegation_wrong_issuer');

  // Pinned per issuer. A token that asks for a different algorithm is refused
  // here, before any key material is selected or used.
  if (header.alg !== issuerPolicy.algorithm) {
    throw new DelegationError('delegation_bad_algorithm');
  }
  if (header.typ !== 'CONQR-OBO') throw new DelegationError('delegation_bad_type');

  const signingInput = `${header64}.${payload64}`;
  let kid: string | null = null;

  if (issuerPolicy.algorithm === 'HS256') {
    if (!issuerPolicy.hmacKey) throw new DelegationError('delegation_not_configured');
    const expected = b64url(
      createHmac('sha256', issuerPolicy.hmacKey).update(signingInput).digest(),
    );
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature64, 'utf8');
    if (a.length !== b.length) {
      timingSafeEqual(a, a);
      throw new DelegationError('delegation_bad_signature');
    }
    if (!timingSafeEqual(a, b)) throw new DelegationError('delegation_bad_signature');
  } else {
    kid = typeof header.kid === 'string' ? header.kid : null;
    if (!kid) throw new DelegationError('delegation_missing_kid');
    const pem = issuerPolicy.publicKeys?.[kid];
    // An unknown or retired kid is refused. It is a lookup, never a fetch.
    if (!pem) throw new DelegationError('delegation_unknown_key');
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      throw new DelegationError('delegation_bad_key');
    }
    const ok = edVerify(
      null,
      Buffer.from(signingInput, 'utf8'),
      publicKey,
      b64urlDecode(signature64),
    );
    if (!ok) throw new DelegationError('delegation_bad_signature');
  }

  if (claims.act !== 'obo') throw new DelegationError('delegation_not_obo');
  if (claims.aud !== policy.audience) {
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

  // A scope the issuer is not permitted to assert invalidates the assertion,
  // rather than being quietly dropped: it means the issuer is misconfigured
  // or is trying something, and both deserve to be visible.
  if (issuerPolicy.allowedScopes) {
    const excess = claims.scope.filter((s) => !issuerPolicy.allowedScopes!.includes(s));
    if (excess.length) throw new DelegationError('delegation_scope_not_permitted');
  }
  if (opts.requiredScope && !claims.scope.includes(opts.requiredScope)) {
    throw new DelegationError('delegation_insufficient_scope');
  }

  return { claims, policy: issuerPolicy, kid };
}

export interface ExchangeOptions {
  /** The verified inbound assertion this delegation derives from. */
  inbound: VerifiedAssertion;
  /** Scopes the invoked tool needs. */
  toolScopes: DelegatedScope[];
  audience: string;
  issuer: string;
  privateKeyPem: string;
  kid: string;
  ttlSeconds?: number;
  now?: number;
}

export interface ExchangedDelegation {
  token: string;
  jti: string;
  scope: string[];
  expiresAt: number;
}

/**
 * Exchange a verified assertion for a downstream delegation.
 *
 * Three narrowings, all of which have to hold at once:
 *
 *   scope    intersection of what was asserted, what the tool needs, and what
 *            the issuer is permitted to assert
 *   lifetime never beyond the inbound assertion's own expiry - a derived token
 *            that outlives its source would let a revoked session keep acting
 *   audience re-addressed to the downstream product, never forwarded
 *
 * The subject and tenant are copied verbatim from the verified claims. They
 * are canonical suite identifiers and re-deriving them here would be a way to
 * get them wrong.
 */
export function exchangeDelegation(opts: ExchangeOptions): ExchangedDelegation {
  const { claims, policy } = opts.inbound;

  let scope = opts.toolScopes.filter((s) => claims.scope.includes(s));
  if (policy.allowedScopes) {
    scope = scope.filter((s) => policy.allowedScopes!.includes(s));
  }
  if (!scope.length) throw new DelegationError('delegation_insufficient_scope');

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const requested = opts.ttlSeconds ?? 300;
  const ceiling = policy.maxTtlSeconds ?? requested;
  let exp = now + Math.min(requested, ceiling);
  if (exp > claims.exp) exp = claims.exp;
  if (exp <= now) throw new DelegationError('delegation_expired');

  const jti = randomUUID();
  const header = b64url(
    JSON.stringify({ alg: 'EdDSA', typ: 'CONQR-OBO', kid: opts.kid }),
  );
  const payload = b64url(
    JSON.stringify({
      sub: claims.sub,
      tid: claims.tid,
      aud: opts.audience,
      scope,
      iat: now,
      nbf: now,
      exp,
      act: 'obo',
      iss: opts.issuer,
      jti,
      // Kept so the downstream audit can tie this token to the assertion it
      // came from without either side having to log the tokens themselves.
      cor: claims.jti,
    }),
  );

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(opts.privateKeyPem);
  } catch {
    throw new DelegationError('delegation_bad_key');
  }
  const signature = b64url(
    edSign(null, Buffer.from(`${header}.${payload}`, 'utf8'), privateKey),
  );

  return { token: `${header}.${payload}.${signature}`, jti, scope, expiresAt: exp };
}
