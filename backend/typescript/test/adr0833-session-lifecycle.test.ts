/**
 * ADR 0833 — session lifecycle hardening, witnessed over the REAL app
 * (`createApp` + the real auth middleware + the users feature's registered
 * session authority). Every block was RED on `97baad74b` before its fix:
 *
 *  S2 / D2 — a break-glass session re-minted by the workspace switch kept its
 *            10-minute `noRefresh` window? (it became a 24h sliding cookie);
 *            break-glass cannot mint an `owk_` key (it could, on every lane).
 *  S3 / D3 — logout ends the session FAMILY server-side: a copied cookie AND a
 *            cookie from before a re-mint are refused; a session's `exp` never
 *            passes `authAt` + the absolute cap; a legacy cookie is
 *            grandfathered, not mass-signed-out.
 *  S7 / D6 — only an owner may disable / delete / sign out an owner.
 *  S8 / D7 — deleting a user revokes their keys in EVERY workspace, and a
 *            re-provisioned account (same deterministic id) does not revive them.
 *  S10 / D9 — an admin's own API key is "self" for the self-lockout rule.
 *  USERS2-CD-1 — a row may not be created under another identity's canonical
 *            id, and deleting a row never revokes ANOTHER human's keys.
 *
 * Refusals are asserted by their CODE (`details.code` / `error`), never by the
 * status alone — a 401/403 from an unrelated guard must not read as a pass.
 *
 * Sabotage that turns it red (one per block): `auth.ts`
 * `refuseRevokedFamily(session, state.revokedFamilies);` deleted reds S3 logout;
 * `cookieSession.ts` `if (source?.noRefresh) exp = Math.min(exp, source.exp);`
 * deleted reds S2; `apiKeyService.ts` `if (issuer.startsWith('breakglass:')) {`
 * → `if (false) {` reds both break-glass key cases; `usersGuards.ts`
 * `if (!targetIsOwner) return;` → `if (true) return;` reds S7.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { resetIssuerLiveCacheForTests } from '../src/middleware/auth.js';
import { COOKIE_TTL_SECONDS, signSession, type SessionPayload } from '../src/middleware/cookieSession.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { getUser, userIdFor } from '../src/features/users/usersService.js';
import { OpenwopError } from '../src/types.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { hashBreakGlassToken, _resetBreakGlassAttempts } from '../src/routes/authBreakGlass.js';

const ME = '/host/openwop-app/users/me';
const USERS = '/host/openwop-app/users/users';
const LOGOUT = '/host/openwop-app/users/auth/logout';
const RUNS = '/runs';

let BASE = '';
let server: http.Server;

interface Body { error?: string; details?: { code?: string; field?: string; reason?: string }; user?: { userId?: string }; userId?: string; sessionEpoch?: number }
interface Hit { status: number; body: Body | undefined; setCookies: string[] }
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
  const body = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as Body | undefined);
  return { status: res.status, body, setCookies };
}
function sessionCookieOf(setCookies: string[]): string | undefined {
  for (const sc of setCookies) {
    const m = /(__session=[^;]+)/.exec(sc);
    if (m && m[1] !== '__session=') return m[1];
  }
  return undefined;
}
function decode(cookiePair: string): SessionPayload & Record<string, unknown> {
  const value = cookiePair.slice('__session='.length);
  return JSON.parse(Buffer.from(value.slice(0, value.indexOf('.')), 'base64url').toString('utf8')) as SessionPayload & Record<string, unknown>;
}
async function login(subject: string, tenantId?: string, sharedWorkspace = false): Promise<{ cookie: string; userId: string }> {
  const res = await hit('/host/openwop-app/test/login', {
    method: 'POST',
    body: { subject, displayName: subject, ...(tenantId ? { tenantId, sharedWorkspace } : {}) },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { cookie: sessionCookieOf(res.setCookies)!, userId: res.body!.user!.userId! };
}
const nowS = (): number => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

// ── S3 / D3 ─────────────────────────────────────────────────────────────────

describe('S3 / D3 — logout ends the session family on the server', () => {
  it('a COPY of the cookie stops working after the owner signs out', async () => {
    const { cookie } = await login('oidc:adr0833-logout-copy');
    expect((await hit(ME, { cookie })).status).toBe(200);
    const out = await hit(LOGOUT, { method: 'POST', cookie });
    expect(out.status).toBe(200);
    const replay = await hit(ME, { cookie });
    expect(replay.status, JSON.stringify(replay.body)).toBe(401);
    expect(replay.body?.error).toBe('session_revoked');
  });

  it('a cookie from BEFORE a re-mint (workspace switch) dies with the family', async () => {
    const { cookie: before } = await login('oidc:adr0833-logout-family');
    const personal = decode(before).personalTenant as string;
    const sw = await hit(`/host/openwop-app/workspaces/${encodeURIComponent(personal)}/switch`, { method: 'POST', cookie: before });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    const after = sessionCookieOf(sw.setCookies)!;
    expect(decode(after).sid).not.toBe(decode(before).sid);
    expect(decode(after).fid, 'a re-mint inherits the family').toBe(decode(before).fid);

    expect((await hit(LOGOUT, { method: 'POST', cookie: after })).status).toBe(200);
    expect((await hit(ME, { cookie: before })).status).toBe(401);
    expect((await hit(ME, { cookie: after })).status).toBe(401);
  });

  it('signing out does not touch the same user’s OTHER sessions', async () => {
    const a = await login('oidc:adr0833-logout-other');
    const b = await login('oidc:adr0833-logout-other');
    expect(decode(a.cookie).fid).not.toBe(decode(b.cookie).fid);
    expect((await hit(LOGOUT, { method: 'POST', cookie: a.cookie })).status).toBe(200);
    expect((await hit(ME, { cookie: b.cookie })).status).toBe(200);
  });

  it('the revocation entry outlives every copy (until = revokedAt + TTL)', async () => {
    const { cookie, userId } = await login('oidc:adr0833-logout-until');
    const fid = decode(cookie).fid;
    expect((await hit(LOGOUT, { method: 'POST', cookie })).status).toBe(200);
    const row = await getUser(userId);
    const entry = row?.revokedFamilies?.find((e) => e.fid === fid);
    expect(entry).toBeTruthy();
    expect(entry!.until).toBeGreaterThanOrEqual(nowS() + COOKIE_TTL_SECONDS - 5);
  });
});

describe('S3 / D3 — the absolute lifetime caps `exp`', () => {
  const CAP_H = 720;
  afterEach(() => { delete process.env.OPENWOP_SESSION_ABSOLUTE_MAX_HOURS; });

  it('a cookie whose authAt is past the cap is not a session at all', async () => {
    const { cookie, userId } = await login('oidc:adr0833-cap-old');
    const p = decode(cookie);
    const old = signSession({ ...p, authAt: nowS() - (CAP_H + 1) * 3600, iat: nowS() - 60, exp: nowS() + 3600 } as SessionPayload);
    const res = await hit(ME, { cookie: `__session=${old}` });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body?.user?.userId).not.toBe(userId);
    // grade-ux USERS2-UX-2 — told so (and signed out), never silently made anonymous.
    expect(res.body?.details?.reason).toBe('session_expired');
    expect(res.setCookies.some((c) => /^__session=;/.test(c)), JSON.stringify(res.setCookies)).toBe(true);
    expect(res.setCookies.some((c) => /^__session=[^;]+/.test(c) && !/^__session=;/.test(c))).toBe(false);
  });

  it('a signed-in cookie past its exp is told session_expired, not swapped for an anon tenant', async () => {
    const { cookie } = await login('oidc:adr0833-cap-exp');
    const p = decode(cookie);
    const ended = signSession({ ...p, iat: nowS() - 7200, exp: nowS() - 60 } as SessionPayload);
    const res = await hit(ME, { cookie: `__session=${ended}` });
    expect(res.status).toBe(401);
    expect(res.body?.details?.reason).toBe('session_expired');
  });

  it('grade-code USERS2-CD-2 — an ANON session carries no authAt and is never capped', async () => {
    const res = await hit(ME);
    const anon = decode(sessionCookieOf(res.setCookies)!);
    expect(anon.tier).toBe('anon');
    expect(anon.authAt).toBeUndefined();
    expect(anon.fid).toBeUndefined();
  });

  it('a sliding refresh never extends exp past authAt + cap', async () => {
    const { cookie } = await login('oidc:adr0833-cap-refresh');
    const p = decode(cookie);
    const authAt = nowS() - (CAP_H - 1) * 3600; // one hour of life left
    const near = signSession({ ...p, authAt, iat: nowS() - 60, exp: nowS() + 600 } as SessionPayload);
    const res = await hit(ME, { cookie: `__session=${near}` });
    expect(res.status).toBe(200);
    const refreshed = sessionCookieOf(res.setCookies);
    expect(refreshed, 'inside the refresh threshold ⇒ a refresh is issued').toBeTruthy();
    expect(decode(refreshed!).exp).toBeLessThanOrEqual(authAt + CAP_H * 3600);
    expect(decode(refreshed!).authAt).toBe(authAt);
  });

  it('a LEGACY cookie (no authAt) is grandfathered: its clock starts at the next refresh', async () => {
    const { cookie } = await login('oidc:adr0833-cap-legacy');
    const { authAt: _drop, fid: _f, ...legacy } = decode(cookie);
    const signed = signSession({ ...legacy, iat: nowS() - 60, exp: nowS() + 600 } as SessionPayload);
    const res = await hit(ME, { cookie: `__session=${signed}` });
    expect(res.status).toBe(200);
    const refreshed = decode(sessionCookieOf(res.setCookies)!);
    expect(Math.abs((refreshed.authAt as number) - nowS())).toBeLessThan(10);
    expect(refreshed.fid, 'a legacy cookie’s family is its sid').toBe(legacy.sid);
  });
});

// ── S2 / D2 ─────────────────────────────────────────────────────────────────

describe('S2 / D2 — break-glass cannot widen itself or mint a durable credential', () => {
  const TENANT = 'ws:adr0833-breakglass';
  const TOKEN = 'adr0833-break-glass-token-1234567890';
  afterEach(() => {
    _resetBreakGlassAttempts();
    for (const k of ['OPENWOP_BREAKGLASS_ENABLED', 'OPENWOP_BREAKGLASS_TOKEN_HASH', 'OPENWOP_BREAKGLASS_TENANT', 'OPENWOP_SUPERADMIN_TENANTS']) delete process.env[k];
  });
  async function breakGlass(): Promise<string> {
    process.env.OPENWOP_BREAKGLASS_ENABLED = 'true';
    process.env.OPENWOP_BREAKGLASS_TOKEN_HASH = hashBreakGlassToken(TOKEN);
    process.env.OPENWOP_BREAKGLASS_TENANT = TENANT;
    process.env.OPENWOP_SUPERADMIN_TENANTS = TENANT;
    const res = await hit('/host/openwop-app/auth/break-glass', { method: 'POST', body: { token: TOKEN } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return sessionCookieOf(res.setCookies)!;
  }

  it('the workspace switch keeps noRefresh and never extends exp', async () => {
    const cookie = await breakGlass();
    const before = decode(cookie);
    expect(before.noRefresh).toBe(true);
    const sw = await hit(`/host/openwop-app/workspaces/${encodeURIComponent(TENANT)}/switch`, { method: 'POST', cookie });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    const after = decode(sessionCookieOf(sw.setCookies)!);
    expect(after.noRefresh).toBe(true);
    expect(after.exp).toBeLessThanOrEqual(before.exp);
  });

  it('issueApiKey refuses a break-glass issuer (covers the CLI-login and pairing POLL lanes)', async () => {
    const err = await issueApiKey({ tenantId: TENANT, name: 'bg', createdBy: 'breakglass:abc' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ httpStatus: 403, details: { code: 'break_glass_cannot_mint' } });
  });

  it('the key mint route refuses a break-glass session with a readable 403', async () => {
    const cookie = await breakGlass();
    const res = await hit('/host/openwop-app/developer-keys', { method: 'POST', cookie, body: { name: 'bg', scopes: ['runs:read'] } });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.details?.code).toBe('break_glass_cannot_mint');
  });
});

// ── S7 / D6 and S10 / D9 ─────────────────────────────────────────────────────

describe('S7 / D6 — only an owner may act on an owner', () => {
  const OWNER = 'saml:adr0833-owner';
  const ADMIN = 'saml:adr0833-admin';
  const OWNER2 = 'saml:adr0833-owner2';
  let WS = '';
  beforeAll(async () => {
    const ws = await createWorkspace({ name: 'ADR 0833 owner rank', ownerSubject: 'user:placeholder-founder' });
    WS = ws.tenantId;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Owner', subject: userIdFor(WS, OWNER), roles: ['owner'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Owner 2', subject: userIdFor(WS, OWNER2), roles: ['owner'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  });

  it.each(['disable', 'sessions/revoke'] as const)('an ADMIN cannot %s an OWNER (403 owner_required)', async (verb) => {
    const owner = await login(OWNER, WS, true);
    const admin = await login(ADMIN, WS, true);
    const res = await hit(`${USERS}/${encodeURIComponent(owner.userId)}/${verb}`, { method: 'POST', cookie: admin.cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.details?.code).toBe('owner_required');
    expect((await getUser(owner.userId))?.status).toBe('active');
  });

  it('an ADMIN cannot DELETE an OWNER', async () => {
    const owner = await login(OWNER, WS, true);
    const admin = await login(ADMIN, WS, true);
    const res = await hit(`${USERS}/${encodeURIComponent(owner.userId)}`, { method: 'DELETE', cookie: admin.cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.details?.code).toBe('owner_required');
    expect(await getUser(owner.userId)).not.toBeNull();
  });

  it('another OWNER may (allowed-with — the refusal above is the rank, not the route)', async () => {
    const owner = await login(OWNER, WS, true);
    const owner2 = await login(OWNER2, WS, true);
    const epochBefore = (await getUser(owner.userId))?.sessionEpoch ?? 0;
    const res = await hit(`${USERS}/${encodeURIComponent(owner.userId)}/sessions/revoke`, { method: 'POST', cookie: owner2.cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body?.sessionEpoch).toBe(epochBefore + 1);
    expect((await getUser(owner.userId))?.sessionEpoch).toBe(epochBefore + 1);
  });

  it('S10 / D9 — an admin’s OWN API key cannot disable the admin (409 self_lockout)', async () => {
    const admin = await login(ADMIN, WS, true);
    const { token } = await issueApiKey({ tenantId: WS, name: 'admin-own', createdBy: admin.userId });
    const res = await hit(`${USERS}/${encodeURIComponent(admin.userId)}/disable`, { method: 'POST', bearer: token });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe('self_lockout');
    expect((await getUser(admin.userId))?.status).toBe('active');
  });
});

// ── S8 / D7 ─────────────────────────────────────────────────────────────────

describe('grade-code USERS2-CD-1 — deleting a row never revokes ANOTHER human’s keys', () => {
  it('a row cannot be created under another identity’s canonical id (400)', async () => {
    const victim = await login('oidc:adr0833-victim');
    const attacker = await login('oidc:adr0833-attacker');
    const res = await hit(USERS, { method: 'POST', cookie: attacker.cookie, body: { principalId: victim.userId } });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body?.details?.field).toBe('principalId');
  });

  it('deleting a row whose bare principal matches a key issuer in ANOTHER tenant leaves that key alive', async () => {
    const t1 = await createWorkspace({ name: 'ADR 0833 CD-1 a', ownerSubject: 'user:placeholder-cd1a' });
    const t2 = await createWorkspace({ name: 'ADR 0833 CD-1 b', ownerSubject: 'user:placeholder-cd1b' });
    const OWNER = 'saml:adr0833-cd1-owner';
    await createMember({ orgId: t1.tenantId, tenantId: t1.tenantId, displayName: 'O', subject: userIdFor(t1.tenantId, OWNER), roles: ['owner'] });
    // Someone else's key in t2, issued under the SAME bare principal string.
    await createMember({ orgId: t2.tenantId, tenantId: t2.tenantId, displayName: 'J', subject: 'scim:jsmith', roles: ['editor'] });
    const { token } = await issueApiKey({ tenantId: t2.tenantId, name: 'jsmith-in-t2', createdBy: 'scim:jsmith' });
    resetIssuerLiveCacheForTests();
    const before = (await hit(RUNS, { bearer: token })).status;
    expect(before).not.toBe(401);

    const owner = await login(OWNER, t1.tenantId, true);
    const created = await hit(USERS, { method: 'POST', cookie: owner.cookie, body: { principalId: 'scim:jsmith' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const del = await hit(`${USERS}/${encodeURIComponent(created.body!.userId!)}`, { method: 'DELETE', cookie: owner.cookie });
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    resetIssuerLiveCacheForTests();
    expect((await hit(RUNS, { bearer: token })).status).toBe(before);
  });
});

describe('S8 / D7 — deleting a user revokes their keys in EVERY workspace', () => {
  it('the deleted user’s key in another workspace is refused, and re-provisioning does not revive it', async () => {
    const U = 'saml:adr0833-leaver';
    const OWN = 'saml:adr0833-t-owner';
    const t = await createWorkspace({ name: 'ADR 0833 home', ownerSubject: 'user:placeholder-t' });
    const T = t.tenantId;
    await createMember({ orgId: T, tenantId: T, displayName: 'Owner', subject: userIdFor(T, OWN), roles: ['owner'] });
    await createMember({ orgId: T, tenantId: T, displayName: 'Leaver', subject: userIdFor(T, U), roles: ['editor'] });
    const u = await login(U, T, true);

    const y = await createWorkspace({ name: 'ADR 0833 other', ownerSubject: 'user:placeholder-y' });
    const Y = y.tenantId;
    await createMember({ orgId: Y, tenantId: Y, displayName: 'Leaver', subject: u.userId, roles: ['editor'] });
    const { token } = await issueApiKey({ tenantId: Y, name: 'leaver-key', createdBy: u.userId });
    resetIssuerLiveCacheForTests();
    expect((await hit(RUNS, { bearer: token })).status, 'precondition: the key works in Y').not.toBe(401);

    const owner = await login(OWN, T, true);
    const del = await hit(`${USERS}/${encodeURIComponent(u.userId)}`, { method: 'DELETE', cookie: owner.cookie });
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    resetIssuerLiveCacheForTests();
    expect((await hit(RUNS, { bearer: token })).status).toBe(401);

    // Same deterministic userId comes back on re-provisioning.
    const again = await login(U, T, true);
    expect(again.userId).toBe(u.userId);
    resetIssuerLiveCacheForTests();
    expect((await hit(RUNS, { bearer: token })).status).toBe(401);
  });
});
