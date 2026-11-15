/**
 * ADR 1122 P0 — `GET /host/openwop-app/assets/:token` decides who may read the bytes.
 * Through the real HTTP boundary, per `OPENWOP_ASSET_ACCESS`:
 *
 *  - `off` serves to anyone holding the token, as before;
 *  - `enforce` serves a workspace member and the owner of a personal tenant, and
 *    refuses a removed member, a stranger and no session with the SAME 404 an unknown
 *    token gets (status, body, no-store);
 *  - a public grant admits anyone, with a short shared-cache header, until revoked;
 *  - session reads are `private` and vary on Cookie (D4);
 *  - `report` serves what `enforce` would refuse.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember, deleteMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { grantPublicAsset, revokePublicAsset } from '../src/host/assetAccess.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let BASE: string;
let server: http.Server;
let wsTenant: string;
let wsAsset: string;
let memberCookie = '';
let removedCookie = '';
let removedMemberId = '';
let strangerCookie = '';

const now = (): number => Math.floor(Date.now() / 1000);
const cookieFor = (userId: string, active: string, personal: string): string =>
  `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: active, tier: 'user', userId, personalTenant: personal, iat: now(), exp: now() + COOKIE_TTL_SECONDS })}`;
const seat = async (principalId: string): Promise<{ cookie: string; memberId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  const m = await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles: ['viewer'] });
  return { cookie: cookieFor(user.userId, wsTenant, `ws:home-${principalId}`), memberId: m.memberId };
};
/** A real anonymous-sandbox session: its personal tenant is `anon:<sid>`. */
const anonSession = (): { tenant: string; cookie: string } => {
  const sid = randomBytes(12).toString('hex');
  const tenant = `anon:${sid}`;
  return { tenant, cookie: `__session=${signSession({ sid, tenantId: tenant, tier: 'anon', personalTenant: tenant, iat: now(), exp: now() + COOKIE_TTL_SECONDS })}` };
};
const store = async (tenantId: string): Promise<string> => (await storeMediaAsset(tenantId, { contentBase64: PNG, contentType: 'image/png' })).token;
const read = async (token: string, cookie?: string): Promise<{ status: number; body: string; cache: string | null; vary: string | null }> => {
  const res = await fetch(`${BASE}/host/openwop-app/assets/${token}`, cookie ? { headers: { cookie } } : {});
  return { status: res.status, body: await res.text(), cache: res.headers.get('cache-control'), vary: res.headers.get('vary') };
};
const setMode = (m: 'off' | 'report' | 'enforce'): void => { process.env.OPENWOP_ASSET_ACCESS = m; };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const owner = await upsertFromPrincipal({ tenantId: 'seed', principalId: 'oidc:aa-owner', source: 'oidc' });
  wsTenant = (await createWorkspace({ name: 'Assets', ownerSubject: owner.userId })).tenantId;
  wsAsset = await store(wsTenant);
  memberCookie = (await seat('oidc:aa-member')).cookie;
  const removed = await seat('oidc:aa-removed');
  removedCookie = removed.cookie;
  removedMemberId = removed.memberId;
  strangerCookie = anonSession().cookie;
});
afterEach(() => { delete process.env.OPENWOP_ASSET_ACCESS; });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 1122 P0 — the serve route decides who may read an asset', () => {
  it('off: the token alone still serves, as before', async () => {
    setMode('off');
    expect((await read(wsAsset)).status).toBe(200);
  });

  it('enforce: a workspace member reads it, privately, varying on Cookie', async () => {
    setMode('enforce');
    const r = await read(wsAsset, memberCookie);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('private, max-age=300');
    expect(r.vary).toContain('Cookie');
  });

  it('enforce: a removed member, a stranger and no session get the 404 an unknown token gets', async () => {
    setMode('enforce');
    expect((await read(wsAsset, removedCookie)).status).toBe(200); // still a member
    await deleteMember(removedMemberId);
    const unknown = await read(`never-minted-${randomBytes(8).toString('hex')}`);
    expect(unknown.status).toBe(404);
    expect(unknown.cache).toBe('no-store');
    for (const cookie of [removedCookie, strangerCookie, undefined]) {
      const r = await read(wsAsset, cookie);
      expect(r.status).toBe(404);
      expect(r.body).toBe(unknown.body);
      expect(r.cache).toBe('no-store');
    }
  });

  it('enforce: a personal tenant admits its owner and nobody else', async () => {
    setMode('enforce');
    const me = anonSession();
    const mine = await store(me.tenant);
    expect((await read(mine, me.cookie)).status).toBe(200);
    expect((await read(mine, strangerCookie)).status).toBe(404);
    expect((await read(mine, memberCookie)).status).toBe(404);
  });

  it('enforce: a public grant admits anyone with a short shared-cache header, until it is revoked', async () => {
    setMode('enforce');
    const pub = await store(wsTenant);
    expect((await read(pub)).status).toBe(404);
    await grantPublicAsset(wsTenant, pub, 'cms:page:test');
    const r = await read(pub);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('public, max-age=60');
    await revokePublicAsset(wsTenant, pub, 'cms:page:test');
    expect((await read(pub)).status).toBe(404);
  });

  it('concurrent grants and revokes keep every other grantor (compare-and-swap)', async () => {
    setMode('enforce');
    const tok = await store(wsTenant);
    const pages = Array.from({ length: 8 }, (_, i) => `cms:page:c${i}`);
    await Promise.all(pages.map((g) => grantPublicAsset(wsTenant, tok, g)));
    await Promise.all(pages.slice(0, 7).map((g) => revokePublicAsset(wsTenant, tok, g)));
    expect((await read(tok)).status).toBe(200); // c7 still holds it
    await revokePublicAsset(wsTenant, tok, 'cms:page:c7');
    expect((await read(tok)).status).toBe(404);
  });

  it('enforce: another tenant granting this token first never blocks the owner\'s own grant', async () => {
    setMode('enforce');
    const tok = await store(wsTenant);
    await grantPublicAsset('ws:squatter', tok, 'cms-page:theirs'); // their page shows our token
    expect((await read(tok)).status).toBe(404); // it admits nothing of ours…
    await grantPublicAsset(wsTenant, tok, 'cms-page:ours');
    expect((await read(tok)).status).toBe(200); // …and our own grant still lands
  });

  it('enforce: a grant from another tenant does not admit the token', async () => {
    setMode('enforce');
    const tok = await store(wsTenant);
    await grantPublicAsset('ws:someone-else', tok, 'cms:page:x');
    expect((await read(tok)).status).toBe(404);
  });

  it('enforce: a session the server refuses (an erased account) reads like no session, never a 401', async () => {
    setMode('enforce');
    const pub = await store(wsTenant);
    await grantPublicAsset(wsTenant, pub, 'cms:page:erased');
    const erased = cookieFor('user:aa-erased-never-existed', 'user:aa-erased', 'user:aa-erased');
    expect((await read(pub, erased)).status).toBe(200);
    expect((await read(wsAsset, erased)).status).toBe(404);
  });

  it('enforce: a stale or invalid session cookie falls through as anonymous, never a 401', async () => {
    setMode('enforce');
    const pub = await store(wsTenant);
    await grantPublicAsset(wsTenant, pub, 'cms:page:stale');
    const expired = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: wsTenant, tier: 'user', userId: 'user:gone', personalTenant: 'user:gone', iat: now() - 7200, exp: now() - 3600 })}`;
    for (const cookie of [expired, '__session=not-a-signed-session']) {
      const ok = await read(pub, cookie);
      expect(ok.status).toBe(200);
      const denied = await read(wsAsset, cookie);
      expect(denied.status).toBe(404);
    }
  });

  it('report: an anonymous read is the same response as off, byte for byte', async () => {
    setMode('off');
    const off = await fetch(`${BASE}/host/openwop-app/assets/${wsAsset}`);
    const offBytes = Buffer.from(await off.arrayBuffer());
    setMode('report');
    const rep = await fetch(`${BASE}/host/openwop-app/assets/${wsAsset}`);
    expect(rep.status).toBe(off.status);
    expect(Buffer.from(await rep.arrayBuffer()).equals(offBytes)).toBe(true);
    for (const h of ['content-type', 'cache-control', 'vary', 'x-content-type-options', 'content-security-policy']) {
      expect(rep.headers.get(h), h).toBe(off.headers.get(h));
    }
  });

  it('report: what enforce would refuse is still served', async () => {
    setMode('report');
    expect((await read(wsAsset, strangerCookie)).status).toBe(200);
    expect((await read(wsAsset)).status).toBe(200);
  });
});
