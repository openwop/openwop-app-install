/**
 * ADR 0969 — superadmin requires a second factor, opt-in.
 *
 * `OPENWOP_SUPERADMIN_REQUIRE_MFA=true` makes a PERSON acting as superadmin
 * hold a verified second factor on this session. Off (the default), nothing
 * changes: an adopter whose identity provider has MFA disabled would otherwise
 * lose every superadmin it has.
 *
 * The predicate cases pin the rule at the one shared gate (`isSuperadmin`,
 * which every admin route and the `/access/effective` projection read). The
 * HTTP cases prove the "MFA'd session" is the host's decision from the
 * VERIFIED ID token claim `firebase.sign_in_second_factor`, not anything the
 * client can assert, and that the refusal names the fix.
 *
 * Sabotage-witnessed (2026-10-23), each turns a case red: dropping the
 * `refusesForMissingMfa` term from `isSuperadmin`; removing the break-glass
 * exemption, or loosening it to a substring match (the IdP-spoof case); widening the check to key principals; reading the flag as
 * default-on; and removing the `mfa_required` branch from `requireSuperadmin`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import express, { type Request } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isSuperadmin, requireSuperadmin, superadminNeedsMfa } from '../src/host/superadmin.js';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';

const OPERATOR = 'user:abc123';

type Kind = 'subject' | 'api-key' | 'env-key';
const req = (opts: { kind: Kind; principalId?: string; mfa?: boolean; tenantId?: string }): Request => ({
  tenantId: opts.tenantId ?? OPERATOR,
  personalTenant: OPERATOR,
  mfaVerified: opts.mfa,
  principal: {
    principalId: opts.principalId ?? 'user:u1', tenants: [opts.tenantId ?? OPERATOR], token: '',
    // A real key principal always carries its declared scopes (here: none, i.e. not narrowed).
    auth: opts.kind === 'api-key' ? { kind: opts.kind, issuer: 'user:u1', scopes: [] } : { kind: opts.kind },
  },
} as unknown as Request);

afterEach(() => {
  delete process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
});

describe('ADR 0969 — isSuperadmin with the MFA requirement', () => {
  it('flag OFF (the default): a single-factor listed person is still a superadmin — unchanged', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    expect(isSuperadmin(req({ kind: 'subject' }))).toBe(true);
    expect(superadminNeedsMfa(req({ kind: 'subject' }))).toBe(false);
  });

  it('flag ON: a single-factor person is refused, and the refusal knows it is only the second factor', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    expect(isSuperadmin(req({ kind: 'subject' }))).toBe(false);
    expect(superadminNeedsMfa(req({ kind: 'subject' }))).toBe(true);
  });

  it('flag ON: an MFA-verified person is a superadmin', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    expect(isSuperadmin(req({ kind: 'subject', mfa: true }))).toBe(true);
    expect(superadminNeedsMfa(req({ kind: 'subject', mfa: true }))).toBe(false);
  });

  it('flag ON: an UNLISTED single-factor person is not told to add MFA (it would not help)', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'user:someone-else';
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    expect(superadminNeedsMfa(req({ kind: 'subject' }))).toBe(false);
  });

  it.each(['api-key', 'env-key'] as const)('flag ON: a %s principal is unaffected (tooling, governed by its own scopes)', (kind) => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    expect(isSuperadmin(req({ kind, principalId: 'apikey:k1' }))).toBe(true);
  });

  it('flag ON: break-glass is exempt — it is the door for when sign-in itself is down', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    expect(isSuperadmin(req({ kind: 'subject', principalId: 'breakglass:abc' }))).toBe(true);
  });

  it.each(['1', 'TRUE', 'yes', ''])('only the exact string "true" turns it on (got %j)', (value) => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = value;
    expect(isSuperadmin(req({ kind: 'subject' }))).toBe(true);
  });

  it('requireSuperadmin names the fix: 403 mfa_required with the Settings → Security link', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    let thrown: unknown;
    try { requireSuperadmin(req({ kind: 'subject' }), 'Governance administration'); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'forbidden', httpStatus: 403, details: { code: 'mfa_required', settingsUrl: '/settings#security' } });
    expect(() => requireSuperadmin(req({ kind: 'subject', mfa: true }))).not.toThrow();
  });
});

// ── over HTTP: the second factor comes from the VERIFIED token, nowhere else ──

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const AUD = 'openwop-test-aud';
let BASE: string;
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
  return `${signingInput}.${b64url(createSign('sha256').update(signingInput).sign(privateKey))}`;
}
/** The personal tenant the host derives for an OIDC subject (`middleware/auth.ts`). */
const personalOf = (sub: string): string => `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;

async function get(path: string, token: string, extra: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, ...extra } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('ADR 0969 — over HTTP', () => {
  beforeAll(async () => {
    const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = priv;
    const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
    const issuerApp = express();
    issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
    issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
    issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;
    process.env.OPENWOP_OIDC_ISSUER = issuer;
    process.env.OPENWOP_OIDC_AUDIENCE = AUD;
    process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    _resetOidcVerifier();
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await new Promise<void>((res) => issuerServer.close(() => res()));
    _resetOidcVerifier();
    for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
  });

  it('flag ON: a single-factor token is refused 403 mfa_required; the same person with the verified claim gets 200', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = personalOf('fb-uid-0969-1');
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    const refused = await get('/host/openwop-app/governance/policy', mint('fb-uid-0969-1'));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({ details: { code: 'mfa_required', settingsUrl: '/settings#security' } });
    const allowed = await get('/host/openwop-app/governance/policy', mint('fb-uid-0969-1', 'totp'));
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it('flag ON: a client cannot claim the second factor — headers asserting MFA change nothing', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = personalOf('fb-uid-0969-2');
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    const forged = await get('/host/openwop-app/governance/policy', mint('fb-uid-0969-2'), {
      'x-openwop-mfa': 'true', 'x-mfa-verified': 'true', 'x-firebase-sign-in-second-factor': 'totp',
    });
    expect(forged.status).toBe(403);
  });

  it('flag OFF: the single-factor token reaches the admin route as before', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = personalOf('fb-uid-0969-3');
    const res = await get('/host/openwop-app/governance/policy', mint('fb-uid-0969-3'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('flag ON: an IdP person whose raw sub is literally "breakglass:x" is namespaced, so still needs MFA', async () => {
    // The break-glass exemption keys on the `breakglass:` principalId, which only
    // routes/authBreakGlass.ts mints. An IdP subject must never reach that shape.
    process.env.OPENWOP_SUPERADMIN_TENANTS = personalOf('breakglass:x');
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    const spoof = await get('/host/openwop-app/governance/policy', mint('breakglass:x'));
    expect(spoof.status, JSON.stringify(spoof.body)).toBe(403);
    expect(spoof.body).toMatchObject({ details: { code: 'mfa_required' } });
    const withMfa = await get('/host/openwop-app/governance/policy', mint('breakglass:x', 'totp'));
    expect(withMfa.status, JSON.stringify(withMfa.body)).toBe(200);
  });

  it('/access/effective says WHY superadmin is false, only for the own resolution, only when it is the second factor', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = personalOf('fb-uid-0969-4');
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    const single = await get('/host/openwop-app/access/effective', mint('fb-uid-0969-4'));
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({ superadmin: false, superadminNeedsMfa: true });
    const mfa = await get('/host/openwop-app/access/effective', mint('fb-uid-0969-4', 'totp'));
    expect(mfa.body).toMatchObject({ superadmin: true });
    expect(mfa.body).not.toHaveProperty('superadminNeedsMfa');
  });
});
