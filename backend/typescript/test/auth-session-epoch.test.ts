/**
 * ADR 0621 — a disabled, deactivated or erased account ends its LIVE sessions.
 *
 * Adversarial route tests over the REAL app (`createApp` + the real auth
 * middleware + the users feature's registered session authority), with a
 * synthetic OIDC issuer for the bearer lanes the signed-in SPA actually takes:
 *
 *  (i)   cookie-only, account disabled → 401 `account_disabled`, cookie CLEARED,
 *        NO anon cookie minted;
 *  (ii)  bearer + stale (disabled) bound cookie → 401 (the OIDC bearer branch's
 *        `boundUserId` point — the branch the SPA takes with a fresh ID token);
 *  (iii) bearer, no cookie, user disabled → 401 `account_disabled` on the
 *        data plane and NO user-tier cookie minted at all (rev. 2, review
 *        BLOCKER-1: the unbound `oidc:<sub>` lane resolves the disabled row by
 *        personal tenant — "no row to disable" was never true for it);
 *  (x)   BLOCKER-1 — the unbound lane: disable ends a live unbound cookie and
 *        refuses every bearer-only data-plane call with no mint; revoke covers
 *        the unbound cookie (its epoch is stamped); erase leaves a tombstone so
 *        neither the middleware nor the canonical fold re-creates a row;
 *  (xi)  NIT-1 — the implicit owner on the unbound lane cannot disable / erase /
 *        revoke its own row past the 409;
 *  (xii) SHOULD-3 — tenant `requireMfa` is enforced on a session whose personal
 *        tenant is deployment-named (the SAML shape); a `user:` tenant stays exempt;
 *  (iv)  erased row → 401 `account_erased`;
 *  (v)   anon sessions untouched (skipped by tier);
 *  (vi)  authority throws → 503 `session_authority_unavailable`, cookie INTACT,
 *        no anon mint (D6: propagate, never grant, never evict);
 *  (vii) self-disable / self-erase / self-revoke → 409 `self_lockout` (D7);
 *  (viii) epoch: two sessions, admin revoke-everywhere → BOTH 401
 *        `session_revoked`; a fresh login works; re-enable does NOT resurrect;
 *        self revoke signs the caller out on the SAME response;
 *  (ix)  SCIM deactivate (`setScimActive` AND `deactivateUser`) bumps the epoch —
 *        the leaver sequence is three writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';
import { createMember, ensurePersonalWorkspace } from '../src/host/accessControlService.js';
import {
  bumpSessionEpoch,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  resolveCanonicalUserForTenant,
  sessionEpochOf,
  setUserStatus,
  tombstoneCanonicalPointer,
  userIdFor,
} from '../src/features/users/usersService.js';
import { deactivateUser, setScimActive } from '../src/host/auth/scimProvisioningService.js';
import { __resetMfaCache, setGovernancePolicy } from '../src/host/governanceService.js';

const ME = '/v1/host/openwop-app/users/me';
const USERS = '/v1/host/openwop-app/users/users';

let BASE = '';
let server: http.Server;
let issuerServer: http.Server;
let issuer = '';
let privateKey: KeyObject;
const AUD = 'openwop-epoch-aud';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function mintBearer(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'epoch-kid', typ: 'JWT' };
  const payload = { iss: issuer, aud: AUD, sub, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(createSign('sha256').update(signingInput).sign(privateKey))}`;
}
/** Reproduce middleware/auth.ts `tenantIdFromOidc`. */
function personalTenantOfSub(sub: string): string {
  return `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;
}

interface Hit { status: number; body: Record<string, unknown> | undefined; setCookies: string[] }
async function hit(path: string, opts: { cookie?: string; bearer?: string; method?: string; body?: unknown } = {}): Promise<Hit> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const single = res.headers.get('set-cookie');
  const setCookies = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
  const body = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined);
  return { status: res.status, body, setCookies };
}

/** The `__session=<value>` pair from a Set-Cookie list (first match). */
function sessionCookieOf(setCookies: string[]): string | undefined {
  for (const sc of setCookies) {
    const m = /(__session=[^;]*)/.exec(sc);
    if (m) return m[1];
  }
  return undefined;
}
function decode(cookiePair: string): Record<string, unknown> {
  const value = cookiePair.slice('__session='.length);
  const payloadB64 = value.slice(0, value.indexOf('.'));
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
}
/** True iff the response EXPIRES the session cookie (`__session=; …Max-Age=0`). */
function clearsCookie(setCookies: string[]): boolean {
  return setCookies.some((sc) => /^__session=;/.test(sc) && /Max-Age=0/.test(sc));
}
/** True iff the response mints an ANON session cookie. */
function mintsAnon(setCookies: string[]): boolean {
  return setCookies.some((sc) => {
    const pair = /(__session=[^;]+)/.exec(sc)?.[1];
    if (!pair || pair === '__session=') return false;
    try { return decode(pair).tier === 'anon'; } catch { return false; }
  });
}
/** True iff the response mints a USER-tier session cookie (bound or unbound). */
function mintsUserTier(setCookies: string[]): boolean {
  return setCookies.some((sc) => {
    const pair = /(__session=[^;]+)/.exec(sc)?.[1];
    if (!pair || pair === '__session=') return false;
    try { return decode(pair).tier === 'user'; } catch { return false; }
  });
}
/** A refused response: the given 401 code, NO user-tier cookie minted. */
function expectRefused(res: Hit, code: string, label: string): void {
  expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(401);
  expect(res.body?.error, label).toBe(code);
  expect(mintsUserTier(res.setCookies), `${label} minted a user-tier cookie: ${JSON.stringify(res.setCookies)}`).toBe(false);
  expect(mintsAnon(res.setCookies), label).toBe(false);
}
const RUNS = '/v1/runs';
const WORKSPACES = '/v1/host/openwop-app/workspaces';

/** Seam login. Collapsed idiom (`sharedWorkspace` absent) when `tenantId` is given. */
async function login(subject: string, tenantId?: string): Promise<{ cookie: string; userId: string }> {
  const res = await hit('/v1/host/openwop-app/test/login', { method: 'POST', body: { subject, displayName: subject, ...(tenantId ? { tenantId } : {}) } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const cookie = sessionCookieOf(res.setCookies);
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, userId: (res.body as { user: { userId: string } }).user.userId };
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'epoch-kid', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  _resetOidcVerifier();

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => issuerServer.close(() => r()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL', 'OPENWOP_TEST_AUTH_ENABLED']) delete process.env[k];
});

describe('(i) cookie-only: a disabled account is refused on its NEXT request', () => {
  it('401 account_disabled, cookie cleared, no anon cookie minted', async () => {
    const { cookie, userId } = await login('oidc:epoch-i');
    expect((await hit(ME, { cookie })).status).toBe(200); // precondition: the session works

    await setUserStatus(userId, 'disabled', { reason: 'admin' });
    const res = await hit(ME, { cookie });
    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('account_disabled');
    expect(clearsCookie(res.setCookies), JSON.stringify(res.setCookies)).toBe(true);
    expect(mintsAnon(res.setCookies)).toBe(false);
  });
});

describe('(ii)/(iii) the OIDC bearer branch — the branch the signed-in SPA actually takes', () => {
  it('(ii) bearer + stale bound cookie → 401 account_disabled + cleared; (iii) bearer alone never re-binds the userId', async () => {
    const sub = 'firebase-uid-epoch-ii';
    const bearer = mintBearer(sub);
    // Bind: the SPA's post-login call that mints the user-tier cookie carrying `userId`.
    const bind = await hit('/v1/host/openwop-app/users/auth/oidc/bind', { method: 'POST', bearer, body: {} });
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    const bound = sessionCookieOf(bind.setCookies)!;
    const payload = decode(bound);
    expect(payload.userId).toBeTruthy();
    expect(payload.epoch).toBe(0);
    const userId = payload.userId as string;
    expect((await hit(ME, { cookie: bound, bearer })).status).toBe(200); // precondition

    await setUserStatus(userId, 'disabled', { reason: 'admin' });

    // (ii) — refused on the bearer branch, cookie cleared, nothing anon minted.
    const stale = await hit(ME, { cookie: bound, bearer });
    expect(stale.status).toBe(401);
    expect(stale.body?.error).toBe('account_disabled');
    expect(clearsCookie(stale.setCookies)).toBe(true);
    expect(mintsAnon(stale.setCookies)).toBe(false);

    // (iii) — the browser now has no cookie but still a valid ID token. Rev. 2
    // (review SHOULD-1 / BLOCKER-1): UNCONDITIONAL — the data plane is refused
    // and NO user-tier cookie of any kind is minted (the old assertion was
    // `if (minted …)`, vacuous when nothing was minted and permissive of an
    // unbound mint that kept the disabled human signed in).
    expectRefused(await hit(ME, { bearer }), 'account_disabled', 'bearer-only /me');
    expectRefused(await hit(USERS, { bearer }), 'account_disabled', 'bearer-only users list');
    expectRefused(await hit(RUNS, { bearer }), 'account_disabled', 'bearer-only /v1/runs');
    expectRefused(await hit(WORKSPACES, { method: 'POST', bearer, body: { name: 'After disable' } }), 'account_disabled', 'bearer-only POST /workspaces');
    // …and the bind lane is refused by the SAME read before the route's own
    // USERS-1 403 can run, so no lane re-binds.
    expectRefused(await hit('/v1/host/openwop-app/users/auth/oidc/bind', { method: 'POST', bearer, body: {} }), 'account_disabled', 'bearer-only bind');
  });
});

describe('(iv) erase → account_erased', () => {
  it('a cookie whose userId no longer resolves a row is refused and cleared', async () => {
    const { cookie, userId } = await login('oidc:epoch-iv');
    expect((await hit(ME, { cookie })).status).toBe(200);
    await deleteUser(userId);
    const res = await hit(ME, { cookie });
    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('account_erased');
    expect(clearsCookie(res.setCookies)).toBe(true);
    expect(mintsAnon(res.setCookies)).toBe(false);
  });
});

describe('(v) anon sessions are untouched (skipped by tier)', () => {
  it('an anon cookie replays to the ROUTE (route-level sign_in_required), never a middleware refusal', async () => {
    const first = await hit(ME);
    const anon = sessionCookieOf(first.setCookies)!;
    expect(decode(anon).tier).toBe('anon');
    const replay = await hit(ME, { cookie: anon });
    expect(replay.status).toBe(401);
    expect(replay.body?.error).toBe('sign_in_required'); // the route's own refusal, not account_*/session_*
    expect(clearsCookie(replay.setCookies)).toBe(false);
  });
});

describe('(vi) D6 — a throwing authority fails THIS request only', () => {
  it('503 session_authority_unavailable, cookie intact, no anon mint; restored authority passes again', async () => {
    const { cookie } = await login('oidc:epoch-vi');
    registerSessionAuthority(async () => { throw new Error('storage blip'); });
    try {
      const res = await hit(ME, { cookie });
      expect(res.status).toBe(503);
      expect(res.body?.error).toBe('session_authority_unavailable');
      expect(clearsCookie(res.setCookies)).toBe(false);
      expect(mintsAnon(res.setCookies)).toBe(false);
    } finally {
      registerSessionAuthority(usersSessionAuthority);
    }
    expect((await hit(ME, { cookie })).status).toBe(200);
  });
});

describe('(vii) D7 — self-lockout refusal', () => {
  it('self disable / erase / admin-revoke → 409 self_lockout; the caller stays signed in', async () => {
    const { cookie, userId } = await login('oidc:epoch-vii'); // implicit owner of its own `user:` tenant
    const id = encodeURIComponent(userId);
    for (const path of [`${USERS}/${id}/disable`, `${USERS}/${id}/sessions/revoke`]) {
      const res = await hit(path, { method: 'POST', cookie });
      expect(res.status, path).toBe(409);
      expect(res.body?.error).toBe('self_lockout');
    }
    const del = await hit(`${USERS}/${id}`, { method: 'DELETE', cookie });
    expect(del.status).toBe(409);
    expect(del.body?.error).toBe('self_lockout');
    expect((await hit(ME, { cookie })).status).toBe(200);
    expect(sessionEpochOf((await getUser(userId))!)).toBe(0); // nothing bumped
  });
});

describe('(viii) epoch — sign out everywhere', () => {
  const TENANT = 'epoch-tenant';
  const ADMIN = 'oidc:epoch-admin';
  const TARGET = 'oidc:epoch-target';

  beforeAll(async () => {
    // A deployment-named tenant (the SAML shape): authority is MEMBERSHIP, so the
    // admin holds an admin row and the target holds nothing.
    await ensurePersonalWorkspace({ tenantId: TENANT, ownerSubject: 'oidc:epoch-founder', name: 'Epoch tenant' });
    await createMember({ orgId: TENANT, tenantId: TENANT, displayName: 'Admin', subject: userIdFor(TENANT, ADMIN), roles: ['admin'] });
  });

  it('admin revoke: BOTH of the target\'s sessions → 401 session_revoked; a fresh login works', async () => {
    const a = await login(TARGET, TENANT);
    const b = await login(TARGET, TENANT);
    expect(a.userId).toBe(b.userId);
    expect(decode(a.cookie).epoch).toBe(0);
    expect((await hit(ME, { cookie: a.cookie })).status).toBe(200);
    expect((await hit(ME, { cookie: b.cookie })).status).toBe(200);

    const admin = await login(ADMIN, TENANT);
    const revoke = await hit(`${USERS}/${encodeURIComponent(a.userId)}/sessions/revoke`, { method: 'POST', cookie: admin.cookie });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expect(revoke.body?.sessionEpoch).toBe(1);

    for (const c of [a.cookie, b.cookie]) {
      const res = await hit(ME, { cookie: c });
      expect(res.status).toBe(401);
      expect(res.body?.error).toBe('session_revoked');
      expect(clearsCookie(res.setCookies)).toBe(true);
      expect(mintsAnon(res.setCookies)).toBe(false);
    }
    // The admin's OWN session is unaffected (a different row).
    expect((await hit(ME, { cookie: admin.cookie })).status).toBe(200);

    // A fresh login stamps the NEW epoch and works.
    const fresh = await login(TARGET, TENANT);
    expect(decode(fresh.cookie).epoch).toBe(1);
    expect((await hit(ME, { cookie: fresh.cookie })).status).toBe(200);
  });

  it('a SEATED member WITHOUT host:members:manage is refused the admin revoke (same gate as disable)', async () => {
    const target = await login(TARGET, TENANT);
    // Review NIT-2: actually seat the peer (an `editor` row — no manage scope),
    // so the 403 below is the SCOPE refusal, not a non-member refusal.
    await createMember({ orgId: TENANT, tenantId: TENANT, displayName: 'Peer', subject: userIdFor(TENANT, 'oidc:epoch-peer'), roles: ['editor'] });
    const peer = await login('oidc:epoch-peer', TENANT);
    expect((await hit(ME, { cookie: peer.cookie })).status).toBe(200); // seated + signed in
    const res = await hit(`${USERS}/${encodeURIComponent(target.userId)}/sessions/revoke`, { method: 'POST', cookie: peer.cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.error).toBe('forbidden_scope');
    expect((await hit(ME, { cookie: target.cookie })).status).toBe(200); // not bumped
    expect(sessionEpochOf((await getUser(target.userId))!)).toBe(1); // still the epoch from the earlier admin revoke
  });

  it('disable → enable does NOT resurrect the old session; a fresh login does', async () => {
    const s = await login('oidc:epoch-reenable');
    await setUserStatus(s.userId, 'disabled', { reason: 'admin' });
    await setUserStatus(s.userId, 'active', { reason: 'admin' });
    const res = await hit(ME, { cookie: s.cookie });
    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('session_revoked');
    const fresh = await login('oidc:epoch-reenable');
    expect((await hit(ME, { cookie: fresh.cookie })).status).toBe(200);
  });

  it('self revoke signs the caller out on the SAME response and kills the sibling session', async () => {
    const a = await login('oidc:epoch-self');
    const b = await login('oidc:epoch-self');
    const res = await hit('/v1/host/openwop-app/users/me/sessions/revoke', { method: 'POST', cookie: a.cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body?.signedOut).toBe(true);
    expect(clearsCookie(res.setCookies)).toBe(true);
    for (const c of [a.cookie, b.cookie]) {
      const r = await hit(ME, { cookie: c });
      expect(r.status).toBe(401);
      expect(r.body?.error).toBe('session_revoked');
    }
  });

  it('factor-event `unbound` bumps the epoch (other sessions end); `bound` does not', async () => {
    const a = await login('oidc:epoch-factor');
    const b = await login('oidc:epoch-factor');
    const bound = await hit('/v1/host/openwop-app/users/me/security/factor-event', { method: 'POST', cookie: a.cookie, body: { event: 'bound' } });
    expect(bound.status).toBe(202);
    expect((await hit(ME, { cookie: b.cookie })).status).toBe(200);
    const unbound = await hit('/v1/host/openwop-app/users/me/security/factor-event', { method: 'POST', cookie: a.cookie, body: { event: 'unbound' } });
    expect(unbound.status).toBe(202);
    const r = await hit(ME, { cookie: b.cookie });
    expect(r.status).toBe(401);
    expect(r.body?.error).toBe('session_revoked');
  });
});

describe('(ix) SCIM deactivation bumps the epoch — the leaver sequence is three writes', () => {
  it('setScimActive(false) AND deactivateUser both bump; reactivate does not reset', async () => {
    const u = await createUser({ tenantId: 'scim-epoch', principalId: 'scim:leaver', source: 'scim', externalId: 'ext-leaver' });
    expect(sessionEpochOf(u)).toBe(0);
    await setScimActive(u, false);
    expect(sessionEpochOf((await getUser(u.userId))!)).toBe(1);
    await setScimActive((await getUser(u.userId))!, true);
    expect(sessionEpochOf((await getUser(u.userId))!)).toBe(1); // re-enable keeps the epoch
    await deactivateUser({ tenantId: 'scim-epoch', externalId: 'ext-leaver' });
    expect(sessionEpochOf((await getUser(u.userId))!)).toBe(2);
    expect((await getUser(u.userId))!.status).toBe('disabled');
  });
});

describe('(x) BLOCKER-1 — the unbound `oidc:<sub>` lane in a personal tenant', () => {
  it('disable: a live UNBOUND cookie is refused + cleared, and every bearer-only data-plane call is refused with NO mint', async () => {
    const sub = 'firebase-uid-unbound-disable';
    const bearer = mintBearer(sub);
    // Bind (the SPA's post-login mint), then reach the data plane over the
    // bound cookie so the canonical pointer exists (`/me` resolves it).
    const bind = await hit('/v1/host/openwop-app/users/auth/oidc/bind', { method: 'POST', bearer, body: {} });
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    const userId = decode(sessionCookieOf(bind.setCookies)!).userId as string;
    expect((await hit(ME, { cookie: sessionCookieOf(bind.setCookies)!, bearer })).status).toBe(200);

    // A bearer-only request (cookie dropped) mints the UNBOUND promotion cookie —
    // rev. 2 stamps the canonical row's epoch on it.
    const bare = await hit(USERS, { bearer });
    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    const unbound = sessionCookieOf(bare.setCookies)!;
    const p = decode(unbound);
    expect(p.tier).toBe('user');
    expect(p.userId).toBeUndefined();
    expect(p.personalTenant).toBe(personalTenantOfSub(sub));
    expect(p.epoch).toBe(0);
    expect((await hit(USERS, { cookie: unbound })).status).toBe(200); // precondition: the unbound cookie works alone
    expect((await hit(WORKSPACES, { method: 'POST', cookie: unbound, body: { name: 'Before' } })).status).toBe(201);

    await setUserStatus(userId, 'disabled', { reason: 'admin' });

    // Cookie-only over the unbound cookie: refused + cleared (the sliding
    // refresh never re-issues it).
    const stale = await hit(USERS, { cookie: unbound });
    expectRefused(stale, 'account_disabled', 'unbound cookie-only');
    expect(clearsCookie(stale.setCookies)).toBe(true);
    // Bearer + the stale unbound cookie: refused on the bearer branch.
    expectRefused(await hit(USERS, { cookie: unbound, bearer }), 'account_disabled', 'bearer + unbound cookie');
    // Bearer-only (the probe that found the hole): every data-plane call is
    // refused and NOTHING user-tier is minted — no renewable session survives.
    expectRefused(await hit(USERS, { bearer }), 'account_disabled', 'bearer-only users');
    expectRefused(await hit(RUNS, { bearer }), 'account_disabled', 'bearer-only runs');
    expectRefused(await hit(WORKSPACES, { method: 'POST', bearer, body: { name: 'After' } }), 'account_disabled', 'bearer-only POST /workspaces');
    expectRefused(await hit(ME, { bearer }), 'account_disabled', 'bearer-only /me');
    // Nothing re-created a second row for the human.
    expect((await listUsers(personalTenantOfSub(sub))).map((u) => u.userId)).toEqual([userId]);
  });

  it('revoke-everywhere covers the unbound cookie: session_revoked + cleared; a fresh bearer-only mint carries the new epoch', async () => {
    const sub = 'firebase-uid-unbound-revoke';
    const bearer = mintBearer(sub);
    // Never bound: the first bearer-only call finds NO row (the ADR 0003 Phase 4
    // residual — allowed), and the route's `resolveCallerUser` creates it.
    const first = await hit(ME, { bearer });
    expect(first.status).toBe(200);
    const userId = (first.body as { userId?: string }).userId ?? (await listUsers(personalTenantOfSub(sub)))[0]!.userId;
    // The second bearer-only call resolves the row (epoch 0) and the unbound
    // cookie minted on the first call (no stamp ⇒ reads 0) still matches.
    const second = await hit(ME, { cookie: sessionCookieOf(first.setCookies)!, bearer });
    expect(second.status).toBe(200);
    const unbound = sessionCookieOf(first.setCookies)!;
    expect(decode(unbound).userId).toBeUndefined();
    expect((await hit(USERS, { cookie: unbound })).status).toBe(200);

    expect(sessionEpochOf((await bumpSessionEpoch(userId))!)).toBe(1); // "sign out everywhere"

    const dead = await hit(USERS, { cookie: unbound });
    expectRefused(dead, 'session_revoked', 'unbound cookie after revoke');
    expect(clearsCookie(dead.setCookies)).toBe(true);
    expectRefused(await hit(USERS, { cookie: unbound, bearer }), 'session_revoked', 'bearer + revoked unbound cookie');
    // The IdP token is still a credential (the ADR's stated posture — the host
    // cannot revoke it; the SPA's hard sign-out drops it), so a bearer-only call
    // mints a FRESH unbound cookie stamped with the NEW epoch.
    const fresh = await hit(USERS, { bearer });
    expect(fresh.status).toBe(200);
    expect(decode(sessionCookieOf(fresh.setCookies)!).epoch).toBe(1);
    expect((await hit(USERS, { cookie: sessionCookieOf(fresh.setCookies)! })).status).toBe(200);
  });

  it('erase leaves a TOMBSTONE: the bearer-only lane and the bind are account_erased, and no row is re-created', async () => {
    const sub = 'firebase-uid-unbound-erase';
    const bearer = mintBearer(sub);
    const home = personalTenantOfSub(sub);
    expect((await hit(ME, { bearer })).status).toBe(200); // row + canonical pointer created by the fold
    const [row] = await listUsers(home);
    expect(row).toBeTruthy();
    // The pair the admin erase route runs: pin the pointer, then delete the row.
    expect(await tombstoneCanonicalPointer(row!)).toBe(true);
    expect(await deleteUser(row!.userId)).toBe(true);

    expectRefused(await hit(ME, { bearer }), 'account_erased', 'bearer-only after erase');
    expectRefused(await hit(USERS, { bearer }), 'account_erased', 'bearer-only users after erase');
    expectRefused(await hit('/v1/host/openwop-app/users/auth/oidc/bind', { method: 'POST', bearer, body: {} }), 'account_erased', 'bind after erase');
    // The creating fold itself refuses on the dangling pointer (defence in
    // depth — this was the `existing[0] ?? createUser(…)` re-creation site).
    await expect(resolveCanonicalUserForTenant({ homeTenant: home, principalId: `oidc:${sub}`, source: 'oidc' }))
      .rejects.toMatchObject({ code: 'account_erased', httpStatus: 401 });
    expect(await listUsers(home)).toEqual([]);
  });

  it('a shared-tenant erase leaves NO tombstone (principal-keyed identity there; the pin is a personal-tenant mechanism)', async () => {
    const u = await createUser({ tenantId: 'erase-org', principalId: 'oidc:org-leaver', source: 'oidc' });
    expect(await tombstoneCanonicalPointer(u)).toBe(false);
  });
});

describe('(xi) NIT-1 — self-lockout on the UNBOUND lane keys on the resolved caller, not `req.userId`', () => {
  it('the implicit owner of a personal tenant, over bearer only, cannot disable / revoke / erase its own row', async () => {
    const sub = 'firebase-uid-unbound-selflock';
    const bearer = mintBearer(sub);
    expect((await hit(ME, { bearer })).status).toBe(200); // creates the caller's row via the fold
    const [row] = await listUsers(personalTenantOfSub(sub));
    const id = encodeURIComponent(row!.userId);
    for (const path of [`${USERS}/${id}/disable`, `${USERS}/${id}/sessions/revoke`]) {
      const res = await hit(path, { method: 'POST', bearer });
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body?.error).toBe('self_lockout');
    }
    const del = await hit(`${USERS}/${id}`, { method: 'DELETE', bearer });
    expect(del.status, JSON.stringify(del.body)).toBe(409);
    expect(del.body?.error).toBe('self_lockout');
    const after = (await getUser(row!.userId))!;
    expect(after.status).toBe('active');
    expect(sessionEpochOf(after)).toBe(0);
    expect((await hit(ME, { bearer })).status).toBe(200);
  });
});

describe('(xii) SHOULD-3 — tenant requireMfa on a deployment-named personal tenant (the SAML shape)', () => {
  it('a single-factor session whose personalTenant IS the requireMfa tenant is refused; a user: personal tenant stays exempt', async () => {
    const TENANT = 'mfa-saml-shape';
    // The seam's collapsed idiom: `personalTenant === tenantId === TENANT`, which
    // is exactly what the SAML ACS mints (`OPENWOP_SAML_TENANT`).
    const s = await login('oidc:mfa-saml-user', TENANT);
    expect(decode(s.cookie).personalTenant).toBe(TENANT);
    expect((await hit(USERS, { cookie: s.cookie })).status).toBe(200);
    await setGovernancePolicy(TENANT, { requireMfa: true });
    __resetMfaCache();
    const refused = await hit(USERS, { cookie: s.cookie });
    expect(refused.status, JSON.stringify(refused.body)).toBe(401);
    expect(refused.body?.error).toBe('unauthenticated');
    expect((refused.body?.details as { reason?: string } | undefined)?.reason).toBe('mfa_required');
    // The enrollment escape hatch stays open on that tenant.
    expect((await hit('/v1/host/openwop-app/users/me/security', { cookie: s.cookie })).status).toBe(200);

    // Contrast: a `user:`-shaped personal tenant is exempt by construction — the
    // human must be able to reach Settings → Security to enroll.
    const personal = await login('oidc:mfa-personal-user');
    const home = decode(personal.cookie).personalTenant as string;
    expect(home.startsWith('user:')).toBe(true);
    await setGovernancePolicy(home, { requireMfa: true });
    __resetMfaCache();
    expect((await hit(USERS, { cookie: personal.cookie })).status).toBe(200);
  });
});
