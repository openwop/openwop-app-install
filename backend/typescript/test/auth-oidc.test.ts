/**
 * OIDC bearer verification on the auth middleware, cookies DISABLED (the
 * server-to-server posture: no cookie fallback, so every verifier outcome is
 * answered on the wire). ADR 0003 / Phase 3.1 (the bearer lane), ADR 0015 (the
 * issuer-scoped personal tenant), RFC 0200 §D (`audience_mismatch` is the
 * top-level code for a verified-but-misaddressed token), ADR 0561 (an env API
 * key is operator-scoped only when configured `<key>:*`).
 *
 * Cases:
 *   1. valid token → `oidc:<sub>` principal, tenant `user:<32 hex>`;
 *   2. the tenant is `user:` + sha256(`<iss>:<sub>`)[0..32] — issuer-SCOPED, so the
 *      same `sub` from two IdPs can never share a tenant (asserted against the
 *      recomputed hash: a sub-only hash goes red here);
 *   3. expired → 401 `unauthenticated`, `details.reason: expired`;
 *   4. wrong audience → 401 `audience_mismatch`, `details.reason: wrong_audience`;
 *   5. an allow-listed env API key still works alongside OIDC (`bearer:<8>`, `['*']`);
 *   6. a non-JWT, non-allow-listed bearer → 401 with the "not recognized" message
 *      (the bearer-branch refusal, distinguishable from the generic
 *      missing-credential 401 further down the middleware).
 *
 * Sabotage that turns it red: `auth.ts` `.update(`${claims.iss}:${claims.sub}`)`
 * → `.update(`${claims.sub}`)` reds case 2.
 *
 * Uses an in-test synthetic OIDC issuer (node:crypto) so the test is hermetic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { authMiddleware, _resetOidcVerifier } from '../src/middleware/auth.js';
import { registerPersonalTenantSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';

// ── tiny synthetic OIDC issuer ───────────────────────────────────

interface SyntheticIssuer {
  issuer: string;
  audience: string;
  jwksUrl: string;
  mint(overrides?: Partial<{ sub: string; aud: string; exp: number; iat: number }>): string;
  close: () => Promise<void>;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function startSyntheticIssuer(audience: string): Promise<SyntheticIssuer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-kid-1';

  // Build a JWKS RFC 7517 entry from the public key
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid, alg: 'RS256', use: 'sig' }] };

  // Serve the JWKS at /.well-known/jwks.json
  const app = express();
  app.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    mint(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', kid, typ: 'JWT' };
      const payload = {
        iss: issuer,
        aud: overrides.aud ?? audience,
        sub: overrides.sub ?? 'firebase-uid-abc123',
        iat: overrides.iat ?? now,
        exp: overrides.exp ?? now + 300,
      };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      const sig = createSign('sha256').update(signingInput).sign(privateKey as KeyObject);
      return `${signingInput}.${b64url(sig)}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── test app + bench ─────────────────────────────────────────────

let appServer: http.Server;
let appPort: number;
let issuer: SyntheticIssuer;

beforeAll(async () => {
  issuer = await startSyntheticIssuer('openwop-test-aud');
  process.env.OPENWOP_OIDC_ISSUER = issuer.issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = issuer.audience;
  process.env.OPENWOP_OIDC_JWKS_URL = issuer.jwksUrl;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; // isolate the bearer path
  // ADR 0621 rev. 2 — the unbound OIDC lane now consults the session authority
  // (no permissive default on the seam). This harness mounts the bare
  // middleware with NO host-ext persistence and no users store, so the honest
  // unbound-lane answer is "no durable row was ever bound" (`null`); the
  // `userId` read is the feature's real one (never reached — no bound cookie).
  registerSessionAuthority(usersSessionAuthority);
  registerPersonalTenantSessionAuthority(async () => null);
  _resetOidcVerifier();

  const app: Express = express();
  app.use(express.json());
  app.use(authMiddleware());
  app.get('/v1/test/whoami', (req, res) => res.json({
    principalId: req.principal?.principalId,
    tenants: req.principal?.tenants,
    tenantId: req.tenantId,
  }));
  appServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  appPort = (appServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await issuer.close();
  delete process.env.OPENWOP_OIDC_ISSUER;
  delete process.env.OPENWOP_OIDC_AUDIENCE;
  delete process.env.OPENWOP_OIDC_JWKS_URL;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  _resetOidcVerifier();
});

const call = (token: string) =>
  fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe('P3.1 OIDC bearer verification', () => {
  it('accepts a valid token and derives user:<hash> tenantId', async () => {
    const token = issuer.mint({ sub: 'firebase-uid-alice' });
    const res = await call(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principalId: string; tenants: string[]; tenantId: string };
    expect(body.principalId).toBe('oidc:firebase-uid-alice');
    expect(body.tenants[0]).toMatch(/^user:[0-9a-f]{32}$/);
    expect(body.tenantId).toBe(body.tenants[0]);
  });

  it('issuer-scoped tenant id — the tenant is user:<sha256(iss:sub)[0..32]>, deterministic per (iss, sub)', async () => {
    // The issuer is part of the hash input, so the same `sub` from a second IdP
    // derives a different tenant. Asserting the exact recomputation is what makes
    // this discriminating: a sub-only hash would still be deterministic.
    const sub = 'firebase-uid-bob';
    const expected = `user:${createHash('sha256').update(`${issuer.issuer}:${sub}`).digest('hex').slice(0, 32)}`;
    const subOnly = `user:${createHash('sha256').update(sub).digest('hex').slice(0, 32)}`;
    expect(expected).not.toBe(subOnly);
    const r1 = await call(issuer.mint({ sub }));
    const r2 = await call(issuer.mint({ sub }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r1.json()) as { tenantId: string }).tenantId).toBe(expected);
    expect(((await r2.json()) as { tenantId: string }).tenantId).toBe(expected);
  });

  it('rejects expired token with reason=expired', async () => {
    const token = issuer.mint({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await call(token);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; details: { reason: string } };
    expect(body.error).toBe('unauthenticated');
    expect(body.details.reason).toBe('expired');
  });

  it('rejects wrong-audience token with reason=wrong_audience', async () => {
    const token = issuer.mint({ aud: 'some-other-audience' });
    const res = await call(token);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; details: { reason: string } };
    expect(body.details.reason).toBe('wrong_audience');
    // RFC 0200 §D — the credential VERIFIED, so the top-level code is the
    // registered `audience_mismatch`, not a generic `unauthenticated`.
    expect(body.error).toBe('audience_mismatch');
  });

  it('API-key Bearer still works alongside OIDC', async () => {
    process.env.OPENWOP_API_KEYS = 'admin-test-key:*'; // ADR 0561 — this leg asserts the OPERATOR principal, which is now opt-in
    try {
      const res = await call('admin-test-key');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { principalId: string; tenants: string[] };
      expect(body.principalId).toBe('bearer:admin-te');
      expect(body.tenants).toEqual(['*']);
    } finally {
      delete process.env.OPENWOP_API_KEYS;
    }
  });

  it('non-JWT bearer with no allow-list hit returns 401 "not recognized"', async () => {
    process.env.OPENWOP_API_KEYS = ''; // empty allow-list, like prod
    try {
      const res = await call('not-a-jwt-just-junk');
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('unauthenticated');
      // The bearer branch's own refusal — NOT the generic missing-credential 401
      // the cookie-disabled tail would also produce.
      expect(body.message).toBe('Bearer token is not recognized by this host.');
    } finally {
      delete process.env.OPENWOP_API_KEYS;
    }
  });
});
