/**
 * Tenant MFA enforcement (ADR 0389 Phase 4) — over HTTP against the real app +
 * synthetic OIDC issuer: a shared workspace whose governance policy sets
 * `requireMfa` refuses single-factor sessions FAIL-CLOSED (401 `mfa_required`
 * with the Settings → Security deep-link), while MFA-verified sessions pass,
 * the personal tenant stays exempt (the enrollment path must be reachable),
 * and the escape routes (logout / switch-back / workspace list / own security
 * read) stay open so a refused session is never a full lockout.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { setGovernancePolicy, __resetMfaCache, __resetGovernanceStore } from '../src/host/governanceService.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let BASE: string;
const AUD = 'openwop-test-aud';
let server: http.Server;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;

function mint(sub: string, secondFactor?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = {
    iss: issuer, aud: AUD, sub, iat: now, exp: now + 300,
    ...(secondFactor ? { firebase: { sign_in_second_factor: secondFactor } } : {}),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  _resetOidcVerifier();

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  await __resetGovernanceStore();
  __resetMfaCache();
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

interface Res<T = unknown> { status: number; body: T }
function client(): {
  get: (p: string, token?: string) => Promise<Res>;
  post: (p: string, token?: string, b?: unknown) => Promise<Res>;
} {
  let cookie = '';
  const call = async (method: string, path: string, token?: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
      if (m) cookie = m[1]!;
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p, t) => call('GET', p, t), post: (p, t, b) => call('POST', p, t, b) };
}

describe('ADR 0389 P4 — tenant requireMfa', () => {
  it('refuses a single-factor session in a requireMfa workspace (fail-closed, deep-linked), passes an MFA session, exempts the personal tenant + escape routes', async () => {
    // Single-factor user: bind, create a shared workspace, switch into it.
    const c = client();
    const noMfa = mint('fb-uid-p4-1');
    expect((await c.post('/v1/host/openwop-app/users/auth/oidc/bind', noMfa)).status).toBe(200);
    const ws = await c.post('/v1/host/openwop-app/workspaces', noMfa, { name: 'MFA-required ws' });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    const wsId = (ws.body as { workspaceId: string }).workspaceId;
    expect((await c.post(`/v1/host/openwop-app/workspaces/${wsId}/switch`, noMfa)).status).toBe(200);

    // Pre-policy: in-workspace reads work.
    expect((await c.get('/v1/host/openwop-app/users/me', noMfa)).status).toBe(200);

    // Flip the policy (service-level — the superadmin PUT is covered elsewhere).
    await setGovernancePolicy(wsId, { requireMfa: true });
    __resetMfaCache();

    // Single-factor session now refused, with the enrollment deep-link.
    const refused = await c.get('/v1/host/openwop-app/users/me', noMfa);
    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.body)).toContain('mfa_required');
    expect(JSON.stringify(refused.body)).toContain('/settings#security');

    // Cookie-only requests are refused the same way (no bearer).
    expect((await c.get('/v1/host/openwop-app/users/me')).status).toBe(401);

    // ESCAPE ROUTES stay open for the refused session: list workspaces, read
    // own security posture, switch BACK to personal, then logout.
    expect((await c.get('/v1/host/openwop-app/me/workspaces', noMfa)).status).toBe(200);
    expect((await c.get('/v1/host/openwop-app/users/me/security', noMfa)).status).toBe(200);
    const who = await c.get('/v1/host/openwop-app/me/workspaces', noMfa);
    const personal = (who.body as { personal: string }).personal;
    expect((await c.post(`/v1/host/openwop-app/workspaces/${personal}/switch`, noMfa)).status).toBe(200);

    // PERSONAL tenant exempt — normal operation resumes after switching back.
    expect((await c.get('/v1/host/openwop-app/users/me', noMfa)).status).toBe(200);

    // An MFA-verified session (the claim) passes in the requireMfa workspace.
    const mfaTok = mint('fb-uid-p4-1', 'totp');
    expect((await c.post(`/v1/host/openwop-app/workspaces/${wsId}/switch`, mfaTok)).status).toBe(200);
    const ok = await c.get('/v1/host/openwop-app/users/me', mfaTok);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // ...and the MFA mark persists on the cookie for cookie-only requests.
    expect((await c.get('/v1/host/openwop-app/users/me')).status).toBe(200);
  });

  it('superadmin PUT round-trips requireMfa (set + clear) and preserves other fields', async () => {
    const admin = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
    const put = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ requireMfa: true, providerAllowlist: ['google'] }),
    });
    expect(put.status).toBe(200);
    const policy1 = ((await put.json()) as { policy: { requireMfa?: boolean; providerAllowlist?: string[] } }).policy;
    expect(policy1.requireMfa).toBe(true);
    expect(policy1.providerAllowlist).toEqual(['google']);

    // Omitting the field PRESERVES it; explicit null clears it.
    const keep = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ providerAllowlist: ['google'] }),
    });
    expect((((await keep.json()) as { policy: { requireMfa?: boolean } }).policy).requireMfa).toBe(true);
    const clear = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ requireMfa: null }),
    });
    expect((((await clear.json()) as { policy: { requireMfa?: boolean } }).policy).requireMfa).toBeUndefined();
  });

  it('GRADE SEC-C1: the byok-chat-budget PUT preserves requireMfa (the wipe that shipped)', async () => {
    const admin = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
    await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ requireMfa: true }),
    });
    const budget = await fetch(`${BASE}/v1/host/openwop-app/governance/byok-chat-budget`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ dailyTokenCap: 1000 }),
    });
    expect(budget.status).toBe(200);
    const after = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, { headers: admin });
    const policy = ((await after.json()) as { policy: { requireMfa?: boolean } }).policy;
    expect(policy.requireMfa).toBe(true);
  });

  it('GRADE SEC-C12: a requireMfa-only PUT preserves retention + allowlist (omission ≠ clear)', async () => {
    const admin = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
    await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin,
      body: JSON.stringify({ providerAllowlist: ['google'], retention: { internalDays: 30 } }),
    });
    await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ requireMfa: true }),
    });
    const after = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, { headers: admin });
    const policy = ((await after.json()) as { policy: { providerAllowlist?: string[]; retention?: { internalDays?: number } } }).policy;
    expect(policy.providerAllowlist).toEqual(['google']);
    expect(policy.retention?.internalDays).toBe(30);
    // Explicit null still clears the allowlist.
    await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ providerAllowlist: null }),
    });
    const cleared = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, { headers: admin });
    expect((((await cleared.json()) as { policy: { providerAllowlist?: string[] } }).policy).providerAllowlist).toBeUndefined();
  });
});
