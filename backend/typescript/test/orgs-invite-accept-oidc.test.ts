/**
 * ADR 0622 D7 review B1 / `USERS-20` — invitation accept on the OIDC lane,
 * with NO test seam for the accepting user.
 *
 * The suite used to be blind here: every accept test signed the recipient in
 * through `routes/authTestSeam.ts`, which passes an email → `'idp'`. The real
 * production lane (a Firebase ID token) never wrote `User.email` at all, so on
 * a personal tenant the ONLY email an OIDC human could get was a self-PATCH →
 * `'self'` → `403 email_unverified`: accept was UNREACHABLE for the lane the
 * app actually ships. This file signs the RECIPIENT in with a real bearer
 * against a synthetic issuer (the `oidc-bind.test.ts` harness) and proves:
 *
 *   - `email_verified: true`  → the row carries the address as `'idp'` with no
 *     bind call (the lazy canonical fold) → accept 201, member created;
 *   - `email_verified: false` → NO email stored → accept 403 `email_unverified`
 *     (the residual: an IdP that does not assert the flag needs an admin-set
 *     address — impossible on a personal tenant — so the copy sends the person
 *     to their IdP or the inviter);
 *   - an unverified sign-in AFTER a verified one never clears/overwrites the
 *     IdP address; a verified sign-in REPLACES a self-set one;
 *   - the bind route folds the verified claim too.
 *
 * Sabotage (run once, restored): drop the `req.oidcEmail = …` line in
 * `middleware/auth.ts` — the verified lane goes red.
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
import { getSetCookies } from './headerCookies.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let BASE = '';
const AUD = 'openwop-test-aud-orginv';
let server: http.Server;
let issuerServer: http.Server;
let issuer = '';
let privateKey: KeyObject;

/** A real RS256 ID token from the synthetic issuer, with the OIDC email claims. */
function mint(sub: string, claims: { email?: string; email_verified?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-orginv', typ: 'JWT' };
  const payload = { iss: issuer, aud: AUD, sub, iat: now, exp: now + 300, ...claims };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

interface Res { status: number; body: any }
type Client = { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> };
/** Bearer (optional) + cookie jar — the SPA shape. `token` may change between calls (re-sign-in). */
function client(tokenOf: () => string | undefined): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const token = tokenOf();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers) as string[]) {
      if (/^__session=;/.test(sc)) { cookie = ''; continue; }
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@idp.test`;
const invitesPath = (orgId: string) => `/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/invites`;
const ACCEPT = '/v1/host/openwop-app/orgs/invitations/accept';
const ME = '/v1/host/openwop-app/users/me';

/** The INVITER may use the seam — the finding is about the RECIPIENT's lane. */
async function inviterOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client(() => undefined);
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('owner') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body;
  return { owner, orgId: org.orgId as string };
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid: 'test-kid-orginv', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  _resetOidcVerifier();

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

describe('USERS-20 — accept on the real OIDC bearer lane (no test seam for the recipient)', () => {
  it('email_verified:true → the row carries the address as idp with NO bind call → accept 201, member created', async () => {
    const { owner, orgId } = await inviterOrg();
    const email = uniqEmail('alice');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);

    const alice = client(() => mint(`fb-alice-${n}`, { email, email_verified: true }));
    const me = await alice.get(ME);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.email).toBe(email);
    expect(me.body.emailProvenance).toBe('idp');

    const acc = await alice.post(ACCEPT, { token: inv.body.token });
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    expect(acc.body.subject).toBe(me.body.userId); // member fields are top-level on the accept response
    const members = await owner.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`);
    expect(members.body.members.some((m: { subject?: string }) => m.subject === me.body.userId)).toBe(true);
  });

  it('email_verified:false → NO email stored → accept 403 email_unverified; the invite is not burned (the stated residual)', async () => {
    const { owner, orgId } = await inviterOrg();
    const email = uniqEmail('bob');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });

    const bob = client(() => mint(`fb-bob-${n}`, { email, email_verified: false }));
    const me = await bob.get(ME);
    expect(me.status).toBe(200);
    expect(me.body.email).toBeUndefined();
    expect(me.body.emailProvenance).toBeUndefined();

    const acc = await bob.post(ACCEPT, { token: inv.body.token });
    expect(acc.status, JSON.stringify(acc.body)).toBe(403);
    expect(acc.body.details).toMatchObject({ code: 'forbidden', reason: 'email_unverified' });
    const preview = await client(() => undefined).get(`/v1/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(inv.body.token)}`);
    expect(preview.status).toBe(200);
  });

  it('a claim WITHOUT the flag (absent) is treated as unverified too', async () => {
    const email = uniqEmail('carol');
    const carol = client(() => mint(`fb-carol-${n}`, { email }));
    const me = await carol.get(ME);
    expect(me.status).toBe(200);
    expect(me.body.email).toBeUndefined();
  });

  it('a verified sign-in REPLACES a self-set address (403 → 201); a later UNVERIFIED sign-in never clears or overwrites the idp address', async () => {
    const { owner, orgId } = await inviterOrg();
    const email = uniqEmail('dana');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'editor' });
    const sub = `fb-dana-${n++}`;
    let token = mint(sub, { email, email_verified: false });
    const dana = client(() => token);
    // Unverified first: no address. She self-PATCHes the invited address
    // (the personal-owner short-circuit lets her) → 'self' → refused.
    const me0 = await dana.get(ME);
    expect(me0.body.email).toBeUndefined();
    const patched = await dana.patch(`/v1/host/openwop-app/users/users/${encodeURIComponent(me0.body.userId)}`, { email });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.emailProvenance).toBe('self');
    const refused = await dana.post(ACCEPT, { token: inv.body.token });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ reason: 'email_unverified' });
    // She confirms the address at the IdP and signs in again: the verified
    // claim replaces the self-set one.
    token = mint(sub, { email, email_verified: true });
    const me1 = await dana.get(ME);
    expect(me1.body.userId).toBe(me0.body.userId);
    expect(me1.body.emailProvenance).toBe('idp');
    // A stale/unverified token later does NOT demote the row.
    token = mint(sub, { email, email_verified: false });
    const me2 = await dana.get(ME);
    expect(me2.body.email).toBe(email);
    expect(me2.body.emailProvenance).toBe('idp');
    token = mint(sub, { email: uniqEmail('dana-other-unverified'), email_verified: false });
    const me3 = await dana.get(ME);
    expect(me3.body.email).toBe(email);
    expect(me3.body.emailProvenance).toBe('idp');
    // And with the verified token she accepts.
    token = mint(sub, { email, email_verified: true });
    expect((await dana.post(ACCEPT, { token: inv.body.token })).status).toBe(201);
  });

  it('the bind route folds the verified claim (emailProvenance idp on the bound row), and a re-bind picks up a newly verified address', async () => {
    const email = uniqEmail('erin');
    const sub = `fb-erin-${n++}`;
    let token = mint(sub, { email, email_verified: false });
    const erin = client(() => token);
    const bind0 = await erin.post('/v1/host/openwop-app/users/auth/oidc/bind');
    expect(bind0.status, JSON.stringify(bind0.body)).toBe(200);
    expect(bind0.body.user.email).toBeUndefined();
    token = mint(sub, { email, email_verified: true });
    const bind1 = await erin.post('/v1/host/openwop-app/users/auth/oidc/bind');
    expect(bind1.status, JSON.stringify(bind1.body)).toBe(200);
    expect(bind1.body.bound).toBe(true);
    expect(bind1.body.user.userId).toBe(bind0.body.user.userId);
    expect(bind1.body.user.email).toBe(email);
    expect(bind1.body.user.emailProvenance).toBe('idp');
  });
});
