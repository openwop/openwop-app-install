/**
 * ADR 0015 §Phase 0 — identity coherence between the bearer and cookie paths.
 * When a request arrives with a valid OIDC bearer, the middleware MUST promote
 * (or mint) the session cookie to a user-tier cookie keyed to the OIDC-derived
 * personal tenant and carrying the `oidc:<sub>` subject. Without it, the next
 * request that DROPS the Authorization header (SPA token-cache race,
 * EventSource) fell back to a still-anon cookie and landed at managed-dispatch
 * as anon — the root cause of `sign_in_required` for signed-in free-tier users,
 * and a non-deterministic loss of `oidc:<sub>`-keyed org membership.
 *
 * Four checks (bare middleware on a bare Express app — no `createApp`):
 *   1. anon cookie + valid bearer → Set-Cookie re-issues `tier:'user'` with the
 *      OIDC tenant;
 *   2. an already-promoted cookie + the matching bearer → NO Set-Cookie
 *      (idempotent steady state);
 *   3. no cookie + valid bearer → a user-tier cookie is minted on the spot;
 *   4. a cookie-only follow-up resolves the SAME `oidc:<sub>` principal, never
 *      a per-session `session:<sid>`.
 *
 * Sabotage that turns it red: `auth.ts` `|| cookieSession.tier !== 'user'` (the
 * promotion condition) deleted reds check 1; the cookie branch's
 * `principalId: session.subject` → `` `session:${session.sid}` `` reds check 4.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { authMiddleware, _resetOidcVerifier } from '../src/middleware/auth.js';
import { registerPersonalTenantSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';

interface SyntheticIssuer {
  issuer: string;
  audience: string;
  jwksUrl: string;
  mint(overrides?: Partial<{ sub: string }>): string;
  close: () => Promise<void>;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function startSyntheticIssuer(audience: string): Promise<SyntheticIssuer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-kid-promo';
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
        aud: audience,
        sub: overrides.sub ?? 'firebase-uid-promo',
        iat: now,
        exp: now + 300,
      };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      const sig = createSign('sha256').update(signingInput).sign(privateKey as KeyObject);
      return `${signingInput}.${b64url(sig)}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let appServer: http.Server;
let appPort: number;
let issuer: SyntheticIssuer;

beforeAll(async () => {
  issuer = await startSyntheticIssuer('openwop-promo-aud');
  process.env.OPENWOP_OIDC_ISSUER = issuer.issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = issuer.audience;
  process.env.OPENWOP_OIDC_JWKS_URL = issuer.jwksUrl;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = ''; // cookie mode ON
  process.env.OPENWOP_SESSION_SECRET = 'a'.repeat(48);
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
  app.get('/v1/test/whoami', (req, res) =>
    res.json({ tenantId: req.tenantId, principalId: req.principal?.principalId }),
  );
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
  delete process.env.OPENWOP_SESSION_SECRET;
  _resetOidcVerifier();
});

function extractCookieValue(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const head = setCookie.split(';')[0];
  if (!head) return null;
  return head.trim();
}

function getCookieValue(kv: string): string {
  const eq = kv.indexOf('=');
  return eq > 0 ? kv.slice(eq + 1) : kv;
}

function decodePayload(cookieValue: string): { tenantId: string; tier: string } | null {
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = cookieValue.slice(0, dot);
  let pad = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
  while (pad.length % 4 !== 0) pad += '=';
  try {
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8')) as { tenantId: string; tier: string };
  } catch {
    return null;
  }
}

describe('OIDC verify → session cookie promotion', () => {
  it('reissues an anon cookie as user-tier when OIDC verifies', async () => {
    // 1. Anonymous request mints an anon cookie.
    const anonRes = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`);
    expect(anonRes.status).toBe(200);
    const anonCookieKv = extractCookieValue(anonRes.headers.get('set-cookie'));
    expect(anonCookieKv).toBeTruthy();
    const anonPayload = decodePayload(getCookieValue(anonCookieKv!));
    expect(anonPayload?.tier).toBe('anon');
    expect(anonPayload?.tenantId.startsWith('anon:')).toBe(true);

    // 2. Same browser signs in: same anon cookie + valid OIDC bearer.
    const token = issuer.mint({ sub: 'firebase-uid-alice' });
    const promoteRes = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
      headers: { authorization: `Bearer ${token}`, cookie: anonCookieKv! },
    });
    expect(promoteRes.status).toBe(200);
    const body = (await promoteRes.json()) as { tenantId: string };
    expect(body.tenantId).toMatch(/^user:[0-9a-f]{32}$/);

    // 3. Response MUST reissue the cookie as user-tier.
    const promotedCookieKv = extractCookieValue(promoteRes.headers.get('set-cookie'));
    expect(promotedCookieKv).toBeTruthy();
    const promotedPayload = decodePayload(getCookieValue(promotedCookieKv!));
    expect(promotedPayload?.tier).toBe('user');
    expect(promotedPayload?.tenantId).toBe(body.tenantId);
  });

  it('is idempotent: an already-user cookie matching the bearer is not reissued', async () => {
    // Bootstrap an upgraded cookie via one promotion request.
    const anonRes = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`);
    const anonCookieKv = extractCookieValue(anonRes.headers.get('set-cookie'))!;
    const token = issuer.mint({ sub: 'firebase-uid-bob' });
    const promoteRes = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
      headers: { authorization: `Bearer ${token}`, cookie: anonCookieKv },
    });
    const userCookieKv = extractCookieValue(promoteRes.headers.get('set-cookie'))!;

    // Now resend with the user cookie AND the matching bearer — no
    // Set-Cookie should appear because identity already agrees.
    const steady = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
      headers: { authorization: `Bearer ${token}`, cookie: userCookieKv },
    });
    expect(steady.status).toBe(200);
    expect(steady.headers.get('set-cookie')).toBeNull();
  });

  it('mints a user-tier cookie when no prior cookie exists', async () => {
    const token = issuer.mint({ sub: 'firebase-uid-carol' });
    const res = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const cookieKv = extractCookieValue(res.headers.get('set-cookie'));
    expect(cookieKv).toBeTruthy();
    const payload = decodePayload(getCookieValue(cookieKv!));
    expect(payload?.tier).toBe('user');
    expect(payload?.tenantId).toMatch(/^user:[0-9a-f]{32}$/);
  });

  // ADR 0015 §Phase 0 — identity coherence across auth paths. The latent RBAC
  // bug: a follow-up request that DROPS the Authorization header used to resolve
  // a fresh `session:<sid>` subject, so an OrgMember bound to `oidc:<sub>` (the
  // bearer-path subject) stopped matching the caller — non-deterministic loss of
  // access to one's own org. The promoted cookie now carries the stable subject.
  it('cookie-only follow-up (no bearer) resolves the SAME oidc:<sub> subject', async () => {
    const token = issuer.mint({ sub: 'firebase-uid-dave' });
    // 1. Bearer request promotes the cookie.
    const promoteRes = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(promoteRes.status).toBe(200);
    const bearerBody = (await promoteRes.json()) as { principalId: string };
    expect(bearerBody.principalId).toBe('oidc:firebase-uid-dave');
    const userCookieKv = extractCookieValue(promoteRes.headers.get('set-cookie'));
    expect(userCookieKv).toBeTruthy();

    // 2. Follow-up with ONLY the cookie (Authorization dropped) MUST resolve the
    //    same subject — not a per-session `session:<sid>`.
    const cookieOnly = await fetch(`http://127.0.0.1:${appPort}/v1/test/whoami`, {
      headers: { cookie: userCookieKv! },
    });
    expect(cookieOnly.status).toBe(200);
    const cookieBody = (await cookieOnly.json()) as { principalId: string };
    expect(cookieBody.principalId).toBe('oidc:firebase-uid-dave');
  });
});
