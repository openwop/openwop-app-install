/**
 * ADR 0389 Phase 1 — Firebase-delegated MFA: the host-side session mark.
 *
 * Proves over HTTP against the real app (createApp + the real auth middleware +
 * a synthetic OIDC issuer):
 *   - a bearer whose ID token carries `firebase.sign_in_second_factor` yields
 *     `mfaSessionVerified: true` on GET /users/me/security (bearer authoritative);
 *   - OIDC bind persists the mark on the user-tier cookie, so cookie-only
 *     follow-ups (dropped Authorization header) keep it;
 *   - a workspace switch re-issues the cookie WITHOUT losing the mark;
 *   - a token without the claim yields false (fail-closed default);
 *   - an unauthenticated caller is refused (no durable identity).
 *
 * The host never handles factor material — enrollment is client↔Firebase; the
 * middleware only reads the verifier's attestation claim.
 *
 * @see docs/adr/0389-account-security-and-secrets-depth.md (Phase 1)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let BASE: string;
const AUD = 'openwop-test-aud';
let server: http.Server;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;

/** Mint a synthetic Firebase-shaped ID token; `secondFactor` adds the
 *  `firebase.sign_in_second_factor` claim Identity Platform stamps after an
 *  MFA-completed sign-in. */
function mint(sub: string, secondFactor?: string, authTime?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = {
    iss: issuer, aud: AUD, sub, iat: now, exp: now + 300,
    ...(authTime !== undefined ? { auth_time: authTime } : {}),
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
/** A cookie-jar client whose bearer can be attached or DROPPED per call — the
 *  cookie-only shape is the whole point of the persisted mark. */
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
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p, t) => call('GET', p, t), post: (p, t, b) => call('POST', p, t, b) };
}

const SECURITY = '/v1/host/openwop-app/users/me/security';

describe('ADR 0389 P1 — second-factor session mark', () => {
  it('bearer with the claim → mfaSessionVerified true (authoritative, pre-bind)', async () => {
    const c = client();
    const token = mint('fb-uid-mfa-1', 'totp');
    const res = await c.get(SECURITY, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mfaSessionVerified).toBe(true);
    expect(res.body.source).toBe('oidc');
  });

  it('bind persists the mark; cookie-only follow-ups keep it; a switch does not lose it', async () => {
    const c = client();
    const token = mint('fb-uid-mfa-2', 'totp');
    const bind = await c.post('/v1/host/openwop-app/users/auth/oidc/bind', token);
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);

    // Dropped Authorization header (SPA token-cache race / EventSource): the
    // user-tier cookie alone must still carry the verified mark.
    const cookieOnly = await c.get(SECURITY);
    expect(cookieOnly.status, JSON.stringify(cookieOnly.body)).toBe(200);
    expect(cookieOnly.body.mfaSessionVerified).toBe(true);

    // A workspace switch re-issues the session cookie — the mark must survive.
    const ws = await c.post('/v1/host/openwop-app/workspaces', token, { name: 'MFA switch ws' });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    const sw = await c.post(`/v1/host/openwop-app/workspaces/${ws.body.workspaceId}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    const afterSwitch = await c.get(SECURITY);
    expect(afterSwitch.body.mfaSessionVerified).toBe(true);
  });

  it('token WITHOUT the claim → false (fail-closed default)', async () => {
    const c = client();
    const token = mint('fb-uid-nomfa-1');
    const bearer = await c.get(SECURITY, token);
    expect(bearer.status).toBe(200);
    expect(bearer.body.mfaSessionVerified).toBe(false);

    const bind = await c.post('/v1/host/openwop-app/users/auth/oidc/bind', token);
    expect(bind.status).toBe(200);
    const cookieOnly = await c.get(SECURITY);
    expect(cookieOnly.status).toBe(200);
    expect(cookieOnly.body.mfaSessionVerified).toBe(false);
  });

  it('GRADE SEC-C17a: the vault step-up PASSES with a fresh auth_time (and fails when stale)', async () => {
    const { setSecret } = await import('../src/byok/secretResolver.js');
    const c = client();
    const nowS = Math.floor(Date.now() / 1000);
    const fresh = mint('fb-uid-stepup-1', undefined, nowS - 10);
    // Become a tenant superadmin for the caller's personal tenant.
    const who = await c.get('/v1/host/openwop-app/me/workspaces', fresh);
    const personal = (who.body as { personal: string }).personal;
    process.env.OPENWOP_SUPERADMIN_TENANTS = personal;
    try {
      // Host bucket: the signed-in tenant's KMS path isn't configured in this
      // env; the step-up gate under test is scope-independent.
      await setSecret('stepup-secret', 'the-value');
      const ok = await c.post('/v1/host/openwop-app/vault/secrets/stepup-secret/reveal', fresh, { scope: 'host' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((ok.body as { value: string }).value).toBe('the-value');

      // A token whose sign-in is older than the window fails closed.
      const stale = mint('fb-uid-stepup-1', undefined, nowS - 3600);
      const refused = await c.post('/v1/host/openwop-app/vault/secrets/stepup-secret/reveal', stale, { scope: 'host' });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).toContain('stepup_required');
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });

  it('unauthenticated caller is refused (no durable identity)', async () => {
    const c = client();
    const res = await c.get(SECURITY);
    expect([401, 403]).toContain(res.status);
  });
});

describe('ADR 0389 § Correction — the authenticator bind/unbind notice', () => {
  const FACTOR_EVENT = '/v1/host/openwop-app/users/me/security/factor-event';

  it('records a bind for the caller and writes a tamper-evident audit row', async () => {
    const c = client();
    const token = mint('fb-uid-bind-1', 'totp');
    await c.post('/v1/host/openwop-app/users/auth/oidc/bind', token);
    const who = await c.get('/v1/host/openwop-app/me/workspaces', token);
    const tenantId = (who.body as { personal: string }).personal;

    const res = await c.post(FACTOR_EVENT, token, { event: 'bound', factorCount: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const { listChain } = await import('../src/host/auditChainService.js');
    const kinds = (await listChain(tenantId)).map((e) => e.kind);
    expect(kinds).toContain('security.mfa.factor-bound');
  });

  it('rejects an unknown event kind (closed world) and refuses anonymous callers', async () => {
    const c = client();
    const token = mint('fb-uid-bind-2', 'totp');
    await c.post('/v1/host/openwop-app/users/auth/oidc/bind', token);
    const bad = await c.post(FACTOR_EVENT, token, { event: 'hacked' });
    expect(bad.status).toBe(422);

    // No credential at all → never 202.
    const anon = client();
    const nobody = await anon.post(FACTOR_EVENT, undefined, { event: 'bound' });
    expect(nobody.status).not.toBe(202);
  });

  it('is NOT an authorization input — asserting `bound` never marks the session verified', async () => {
    // The honesty boundary: the claim in the ID token is the only signal that
    // can flip mfaSessionVerified. A client-asserted bind must not.
    const c = client();
    const token = mint('fb-uid-bind-3'); // NO second-factor claim
    await c.post('/v1/host/openwop-app/users/auth/oidc/bind', token);
    expect((await c.get(SECURITY)).body.mfaSessionVerified).toBe(false);

    const res = await c.post(FACTOR_EVENT, token, { event: 'bound', factorCount: 1 });
    expect(res.status).toBe(202);
    // Still false — the assertion recorded a notice, it did NOT grant anything.
    expect((await c.get(SECURITY)).body.mfaSessionVerified).toBe(false);
  });
});
