/**
 * ADR 0003 Phase 4a — OIDC bind route + middleware honoring of the bound userId.
 *
 * Proves over HTTP against the real app (createApp + the real auth middleware +
 * a synthetic OIDC issuer):
 *   - POST /v1/host/openwop-app/users/auth/oidc/bind find-or-creates a durable User for
 *     the verified oidc:<sub> and is idempotent;
 *   - it re-keys an existing membership seeded under oidc:<sub> to the canonical
 *     user:<userId> (the personal-workspace owner member, deterministic id);
 *   - after bind, the bound user-tier cookie makes the OIDC bearer resolve the
 *     stable user:<userId> subject (membership keys on it);
 *   - bind without an OIDC bearer is refused.
 *
 * @see docs/adr/0003-canonical-user-identity-session-binding.md (Phase 4a)
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listMembers, isWorkspaceMember } from '../src/host/accessControlService.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const PORT = 18672;
const BASE = `http://127.0.0.1:${PORT}`;
const AUD = 'openwop-test-aud';
let server: http.Server;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;

function mint(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = { iss: issuer, aud: AUD, sub, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

/** Reproduce middleware/auth.ts `tenantIdFromOidc`. */
function personalTenantOfSub(sub: string): string {
  return `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  _resetOidcVerifier();

  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

interface Res<T = any> { status: number; body: T }
/** A bearer-carrying client with a cookie jar (the SPA shape: bearer + __session). */
function client(token: string): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

describe('ADR 0003 Phase 4a — OIDC bind', () => {
  it('refuses bind without an OIDC bearer', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/users/auth/oidc/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('binds an OIDC subject to a durable User (idempotent) + re-keys the personal-owner member', async () => {
    const sub = 'firebase-uid-bind-1';
    const oidcSubject = `oidc:${sub}`;
    const personalTenant = personalTenantOfSub(sub);
    const c = client(mint(sub));

    // First touch seeds the personal workspace under the UNBOUND subject oidc:<sub>.
    expect((await c.get('/v1/host/openwop-app/me/workspaces')).status).toBe(200);
    expect(await isWorkspaceMember(oidcSubject, personalTenant)).toBe(true);

    // Bind: creates the durable User + re-keys the owner member to user:<userId>.
    const bind = await c.post('/v1/host/openwop-app/users/auth/oidc/bind');
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    expect(bind.body.bound).toBe(true);
    const userId = bind.body.user.userId as string;
    expect(userId).toMatch(/^user:/);
    expect(bind.body.rekeyed).toBe(1); // the personal-owner member moved

    // The owner member now keys on the canonical user:<userId>, not oidc:<sub>.
    expect(await isWorkspaceMember(userId, personalTenant)).toBe(true);
    expect(await isWorkspaceMember(oidcSubject, personalTenant)).toBe(false);
    const owners = (await listMembers(personalTenant, personalTenant)).filter((m) => m.roles.includes('owner'));
    expect(owners.length).toBe(1);
    expect(owners[0]!.subject).toBe(userId);

    // Idempotent: a second bind resolves the SAME userId, nothing left to re-key.
    const bind2 = await c.post('/v1/host/openwop-app/users/auth/oidc/bind');
    expect(bind2.body.user.userId).toBe(userId);
    expect(bind2.body.rekeyed).toBe(0);
  });

  it('after bind, the bound cookie makes the bearer resolve the durable user:<userId>', async () => {
    const sub = 'firebase-uid-bind-2';
    const personalTenant = personalTenantOfSub(sub);
    const c = client(mint(sub));

    const bind = await c.post('/v1/host/openwop-app/users/auth/oidc/bind');
    const userId = bind.body.user.userId as string;

    // A subsequent request (bearer + bound cookie) resolves user:<userId>: the
    // personal-workspace owner membership (keyed user:<userId>) is honored.
    const me = await c.get('/v1/host/openwop-app/me/workspaces');
    expect(me.status).toBe(200);
    const personal = me.body.workspaces.find((w: any) => w.workspaceId === personalTenant);
    expect(personal).toBeTruthy();
    expect(personal.roles).toContain('owner');
    expect(await isWorkspaceMember(userId, personalTenant)).toBe(true);
  });

  // Regression: a bound OIDC user who switches into a SHARED workspace must STAY
  // there on subsequent BEARER requests. The switch's issueUserSession drops the
  // cookie `subject`; matching the bound cookie on `subject` (the old code) would
  // un-bind the caller → bounce them to personal as oidc:<sub> → lose access to
  // their re-keyed shared memberships. The fix matches on `personalTenant`.
  it('a bound OIDC user STAYS in a switched shared workspace on bearer requests', async () => {
    const sub = 'firebase-uid-switch';
    const c = client(mint(sub));

    const userId = (await c.post('/v1/host/openwop-app/users/auth/oidc/bind')).body.user.userId as string;

    // Create a shared workspace (caller becomes owner) and switch into it.
    const ws = (await c.post('/v1/host/openwop-app/workspaces', { name: 'SwitchCo' })).body.workspaceId as string;
    expect(ws).toMatch(/^ws:/);
    const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.active).toBe(ws);

    // The next BEARER request must keep active === ws (not revert to personal)
    // and resolve the caller as user:<userId> (shared membership keyed on it).
    const me = await c.get('/v1/host/openwop-app/me/workspaces');
    expect(me.body.active).toBe(ws);
    const shared = me.body.workspaces.find((w: any) => w.workspaceId === ws);
    expect(shared?.roles).toContain('owner');
    expect(await isWorkspaceMember(userId, ws)).toBe(true);
  });
});
