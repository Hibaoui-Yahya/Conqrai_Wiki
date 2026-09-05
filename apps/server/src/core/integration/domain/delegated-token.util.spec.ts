import {
  CONQRPLAN_AUDIENCE,
  DELEGATED_SCOPES,
  mintDelegatedToken,
  verifyDelegatedToken,
} from './delegated-token.util';
import { toOrgUid, toPersonUid } from './canonical-identity.util';

const SECRET = 'obo-signing-key-at-least-32-chars-xx';
const PERSON = toPersonUid('9f1c2d3e-0000-4000-8000-000000000001');
const ORG = toOrgUid('4ab29c10-0000-4000-8000-0000000000aa');
const ISSUER = 'conqrhub';

const base = {
  sub: PERSON,
  tid: ORG,
  aud: CONQRPLAN_AUDIENCE,
  scope: [DELEGATED_SCOPES.workItemCreate as string],
  ttlSeconds: 300,
  nowSeconds: 1_000_000,
  issuer: ISSUER,
};

const verifyOpts = (over: Record<string, unknown> = {}) => ({
  audience: CONQRPLAN_AUDIENCE,
  issuer: ISSUER,
  nowSeconds: 1_000_100,
  ...over,
});

describe('delegated-token', () => {
  it('mints a token carrying the canonical actor, tenant, issuer and jti', () => {
    const token = mintDelegatedToken(base, SECRET);
    const res = verifyDelegatedToken(token, verifyOpts({ requiredScope: 'work-item:create' }), SECRET);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.sub).toBe(PERSON);
      expect(res.claims.tid).toBe(ORG);
      expect(res.claims.act).toBe('obo');
      expect(res.claims.iss).toBe(ISSUER);
      // jti doubles as the correlation id, so it must always be present.
      expect(res.claims.jti).toEqual(expect.any(String));
      expect(res.claims.jti.length).toBeGreaterThan(0);
      expect(res.claims.nbf).toBe(base.nowSeconds);
    }
  });

  it('mints a distinct jti per token so two calls are separable in an audit trail', () => {
    const a = mintDelegatedToken(base, SECRET);
    const b = mintDelegatedToken(base, SECRET);
    expect(a).not.toBe(b);
  });

  // -------------------------------------------------------------------------
  // Identity claims must be canonical
  // -------------------------------------------------------------------------

  it('refuses to mint a delegation naming a bare row id', () => {
    // This is the shape the old unsigned X-Conqr-On-Behalf-Of header carried.
    // It must not be expressible in a signed delegation.
    expect(() => mintDelegatedToken({ ...base, sub: 'user_1' }, SECRET)).toThrow(
      /canonical person_uid/,
    );
    expect(() => mintDelegatedToken({ ...base, tid: 'ws_1' }, SECRET)).toThrow(
      /canonical org_uid/,
    );
  });

  it('refuses to mint a delegation with no scope', () => {
    expect(() => mintDelegatedToken({ ...base, scope: [] }, SECRET)).toThrow(/scope/);
  });

  it('refuses to mint without an issuer', () => {
    expect(() => mintDelegatedToken({ ...base, issuer: '' }, SECRET)).toThrow(/issuer/);
  });

  it('rejects a token whose subject is not a canonical person_uid', () => {
    // Forged by signing a hand-built payload with the real key: signature is
    // valid, so only the claim check can stop it.
    const forged = signClaims({ ...claimsFor(base), sub: 'user_1' });
    expect(verifyDelegatedToken(forged, verifyOpts(), SECRET)).toEqual({
      ok: false,
      reason: 'bad_subject',
    });
  });

  it('rejects a token whose tenant is not a canonical org_uid', () => {
    const forged = signClaims({ ...claimsFor(base), tid: 'ws_1' });
    expect(verifyDelegatedToken(forged, verifyOpts(), SECRET)).toEqual({
      ok: false,
      reason: 'bad_tenant',
    });
  });

  it('rejects a token with no jti', () => {
    const c = claimsFor(base) as Record<string, unknown>;
    delete c.jti;
    expect(verifyDelegatedToken(signClaims(c), verifyOpts(), SECRET)).toEqual({
      ok: false,
      reason: 'missing_jti',
    });
  });

  // -------------------------------------------------------------------------
  // Audience, issuer, scope, time
  // -------------------------------------------------------------------------

  it('rejects a wrong audience (confused-deputy guard)', () => {
    const token = mintDelegatedToken(base, SECRET);
    expect(verifyDelegatedToken(token, verifyOpts({ audience: 'hub' }), SECRET)).toEqual({
      ok: false,
      reason: 'wrong_audience',
    });
  });

  it('rejects a wrong issuer', () => {
    const token = mintDelegatedToken({ ...base, issuer: 'somebody-else' }, SECRET);
    expect(verifyDelegatedToken(token, verifyOpts(), SECRET)).toEqual({
      ok: false,
      reason: 'wrong_issuer',
    });
  });

  it('rejects insufficient scope (least privilege)', () => {
    const token = mintDelegatedToken(base, SECRET);
    expect(
      verifyDelegatedToken(
        token,
        verifyOpts({ requiredScope: DELEGATED_SCOPES.estimateConfigure }),
        SECRET,
      ),
    ).toEqual({ ok: false, reason: 'insufficient_scope' });
  });

  it('rejects an expired token', () => {
    const token = mintDelegatedToken(base, SECRET);
    expect(
      verifyDelegatedToken(token, verifyOpts({ nowSeconds: 1_000_000 + 301 }), SECRET),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token that is not yet valid', () => {
    const token = mintDelegatedToken({ ...base, nowSeconds: 1_000_500 }, SECRET);
    expect(
      verifyDelegatedToken(token, verifyOpts({ nowSeconds: 1_000_000 }), SECRET),
    ).toEqual({ ok: false, reason: 'not_yet_valid' });
  });

  it('tolerates configured clock skew at both ends', () => {
    const token = mintDelegatedToken({ ...base, nowSeconds: 1_000_010 }, SECRET);
    // 10s early, within a 30s allowance.
    const res = verifyDelegatedToken(
      token,
      verifyOpts({ nowSeconds: 1_000_000, clockSkewSeconds: 30 }),
      SECRET,
    );
    expect(res.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Signature
  // -------------------------------------------------------------------------

  it('rejects a tampered payload', () => {
    const token = mintDelegatedToken(base, SECRET);
    const [h, , s] = token.split('.');
    const forged = b64url(
      JSON.stringify({ ...claimsFor(base), sub: toPersonUid('attacker-id') }),
    );
    expect(verifyDelegatedToken(`${h}.${forged}.${s}`, verifyOpts(), SECRET).ok).toBe(false);
  });

  it('rejects a token signed with a different key', () => {
    const token = mintDelegatedToken(base, SECRET);
    expect(verifyDelegatedToken(token, verifyOpts(), 'a-different-key-32-chars-long-xxx')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a token that is not a delegation at all', () => {
    const c = claimsFor(base) as Record<string, unknown>;
    c.act = 'session';
    expect(verifyDelegatedToken(signClaims(c), verifyOpts(), SECRET)).toEqual({
      ok: false,
      reason: 'not_delegated',
    });
  });

  it('rejects a missing or malformed token', () => {
    expect(verifyDelegatedToken(undefined, verifyOpts(), SECRET).ok).toBe(false);
    expect(verifyDelegatedToken('nonsense', verifyOpts(), SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers: build and sign arbitrary claim sets, so the verifier can be tested
// against payloads mintDelegatedToken would refuse to produce.
// ---------------------------------------------------------------------------

function b64url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function claimsFor(p: typeof base): Record<string, unknown> {
  return {
    sub: p.sub,
    tid: p.tid,
    aud: p.aud,
    scope: p.scope,
    iat: p.nowSeconds,
    nbf: p.nowSeconds,
    exp: p.nowSeconds + p.ttlSeconds,
    act: 'obo',
    iss: p.issuer,
    jti: 'fixed-jti-for-tests',
  };
}

function signClaims(claims: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac } = require('node:crypto');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'CONQR-OBO' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = Buffer.from(
    createHmac('sha256', SECRET).update(`${header}.${payload}`).digest(),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${sig}`;
}
