/**
 * ADR 0434 Phase 2 + the 2026-05-24 bearer → cookie fall-through, with cookies
 * ENABLED (the browser deploy shape). The Firebase JS SDK rotates ID tokens
 * ~hourly; a request landing in the rotation window carries a stale bearer.
 *
 *   1. stale (expired) OIDC JWT + HEALTHY `__session` cookie → the request
 *      survives on the SAME cookie session (`session:<sid>`), not a 401 storm;
 *   2. bogus non-JWT bearer + NO cookie → 401 `bearer_rejected_no_session`
 *      and NO Set-Cookie — never a silently-minted new anon identity (the
 *      ADR 0434 silent-identity-switch / data-loss chain);
 *   3. expired JWT + NO cookie → the same refusal;
 *   4. NO bearer at all + no cookie → an anon session IS still minted (the
 *      public demo's allowed-with control: the refusal above is the rejected
 *      bearer, not the missing cookie).
 *
 * The "valid JWT → oidc:* principal" and Firebase-claim-shape cases that used to
 * open this file were cut: the same break (`oidc:${claims.sub}` mis-derived)
 * reds `auth-oidc.test.ts` "accepts a valid token…", and no current verifier
 * change distinguishes the Firebase claim shape from it.
 * The cookies-DISABLED strict-401 posture lives in `auth-oidc.test.ts`.
 *
 * Sabotage that turns it red: `auth.ts` `if (bearerRejected) {` → `if (false) {`
 * reds cases 2 and 3.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { authMiddleware, _resetOidcVerifier } from '../src/middleware/auth.js';
import { registerPersonalTenantSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';

// ── tiny synthetic OIDC issuer ───────────────────────────────────
// Mirrors the helper in auth-oidc.test.ts. Kept inline so this test
// is hermetic and can run in isolation (vitest's file-level isolation
// means the other test's beforeAll doesn't apply here).

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
  const kid = 'test-kid-fallthrough';
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid, alg: 'RS256', use: 'sig' }] };

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
        sub: overrides.sub ?? 'firebase-uid-stale',
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
  // Cookies ENABLED — the browser deploy shape, where the fall-through
  // is supposed to engage.
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
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
  _resetOidcVerifier();
});

function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  // "__session=<value>; Path=/; Max-Age=..." → just `__session=<value>`.
  const head = setCookieHeader.split(';')[0]!;
  return head.trim();
}

const call = (headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, { headers });

describe('bearer → cookie fall-through (browser-shape deploys)', () => {
  it('expired JWT + valid session cookie → session:* principal, NOT 401', async () => {
    // Step 1: warm up an anon session so we have a real signed cookie.
    const seed = await call();
    expect(seed.status).toBe(200);
    const sessionCookie = extractSessionCookie(seed.headers.get('set-cookie'));
    expect(sessionCookie).toMatch(/^__session=/);
    const seedBody = (await seed.json()) as { principalId: string };
    expect(seedBody.principalId).toMatch(/^session:/);

    // Step 2: replay the same cookie alongside an expired JWT.
    // Pre-fix behavior: 401 (bearer kills the request before cookie
    // path runs). Post-fix: bearer verify fails, fall through, cookie
    // path resolves the same session.
    const expired = issuer.mint({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await call({
      authorization: `Bearer ${expired}`,
      cookie: sessionCookie!,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principalId: string };
    expect(body.principalId).toMatch(/^session:/);
    // Same session id — fall-through didn't mint a new anon session
    // when a valid cookie was present.
    expect(body.principalId).toBe(seedBody.principalId);
  });

  // ── ADR 0434 Phase 2 — cases 2 and 3 below were DELIBERATELY OVERTURNED ──
  // They previously asserted "fresh anon session minted, NOT 401". That was
  // reasoned from this file's 401-storm rationale, but the storm protection is
  // case 1 above (stale bearer + HEALTHY cookie → request survives), which is
  // untouched. With NO cookie there is no session to preserve: minting handed
  // the caller a BRAND-NEW `anon:<sid>` identity mid-session.
  //
  // In production that completed a silent data-loss chain: `/migrate-tenant`
  // used to clear the session cookie on success, so a signed-in user was
  // cookie-less; the next hourly token rotation raced; they were silently
  // issued a new anonymous tenant and kept working in it, invisibly to every
  // other device. A 401 is honest and recoverable — the SPA refreshes the token
  // and retries — whereas a silent identity switch is neither.
  //
  // A visitor presenting NO bearer is unaffected: `bearerRejected` stays false
  // and the anon mint still happens, so the public demo is unchanged.

  it('bogus non-JWT bearer + no cookie → 401, NEVER a new anon identity', async () => {
    const res = await call({ authorization: 'Bearer not-a-jwt-just-junk' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe('bearer_rejected_no_session');
    // The critical assertion: no session cookie was minted, so the caller was
    // not silently handed a different tenant to write into.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('expired JWT + no cookie → 401, NEVER a new anon identity', async () => {
    const expired = issuer.mint({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await call({ authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe('bearer_rejected_no_session');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('NO bearer at all + no cookie → anon session still minted (demo unchanged)', async () => {
    const res = await call({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principalId: string };
    expect(body.principalId).toMatch(/^session:/);
    const minted = extractSessionCookie(res.headers.get('set-cookie'));
    expect(minted).toMatch(/^__session=/);
    const payloadB64 = minted!.slice('__session='.length).split('.')[0]!;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { tier?: string; sid?: string };
    expect(payload.tier).toBe('anon');
    expect(body.principalId).toBe(`session:${payload.sid}`);
  });
});
