/**
 * Issue 5929 item 2 — `GET /orgs` listed every org in the tenant, so in a workspace
 * holding several clients every member saw every client's name in each org picker.
 * It now lists the orgs the caller can act in. Through the real HTTP boundary:
 *
 *  - a root viewer who belongs to client A sees the root and A, never B;
 *  - a root viewer with no client membership sees the root only;
 *  - the owner and a root admin (`host:members:manage`) see every org;
 *  - act-as narrows: the admin acting as the viewer loses B;
 *  - a caller with no session sees nothing;
 *  - an anonymous sandbox still sees the org it created (its own tenant);
 *  - the Access hub's org count follows the same list.
 *
 * Red on the old reader: the viewer legs see B.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember, createOrg } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let clientA: string;
let clientB: string;
const cookies = { owner: '', viewer: '', bare: '', admin: '' };
let viewerMemberId: string;

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seat = async (principalId: string, roles: string[]): Promise<{ cookie: string; userId: string; memberId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  const m = await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
  return { cookie: craftCookie(user.userId, wsTenant, `ws:home-${principalId}`), userId: user.userId, memberId: m.memberId };
};
const get = async <T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as T };
};
const orgIds = async (headers: Record<string, string>): Promise<string[]> => {
  const r = await get<{ orgs: { orgId: string }[] }>('/host/openwop-app/orgs', headers);
  expect(r.status).toBe(200);
  return r.body.orgs.map((o) => o.orgId).sort();
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  const owner = await upsertFromPrincipal({ tenantId: 'seed', principalId: 'oidc:ol-owner', source: 'oidc' });
  const ws = await createWorkspace({ name: 'Agency', ownerSubject: owner.userId });
  wsTenant = ws.tenantId;
  cookies.owner = craftCookie(owner.userId, wsTenant, 'ws:home-ol-owner');
  clientA = (await createOrg({ tenantId: wsTenant, createdBy: owner.userId, name: 'Client A' })).orgId;
  clientB = (await createOrg({ tenantId: wsTenant, createdBy: owner.userId, name: 'Client B' })).orgId;

  const viewer = await seat('oidc:ol-viewer', ['viewer']);
  cookies.viewer = viewer.cookie;
  viewerMemberId = viewer.memberId;
  await createMember({ tenantId: wsTenant, orgId: clientA, subject: viewer.userId, displayName: 'viewer', roles: ['editor'] });
  cookies.bare = (await seat('oidc:ol-bare', ['viewer'])).cookie;
  cookies.admin = (await seat('oidc:ol-admin', ['admin'])).cookie;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('issue 5929 item 2 — GET /orgs lists only the orgs the caller can act in', () => {
  it('a member of client A sees the workspace and A, not B', async () => {
    expect(await orgIds({ cookie: cookies.viewer })).toEqual([wsTenant, clientA].sort());
  });

  it('a workspace member with no client membership sees the workspace only', async () => {
    expect(await orgIds({ cookie: cookies.bare })).toEqual([wsTenant]);
  });

  it('the owner and a workspace admin see every org', async () => {
    const all = [wsTenant, clientA, clientB].sort();
    expect(await orgIds({ cookie: cookies.owner })).toEqual(all);
    expect(await orgIds({ cookie: cookies.admin })).toEqual(all);
  });

  it('act-as narrows: the admin acting as the viewer no longer sees B', async () => {
    const seen = await orgIds({ cookie: cookies.admin, 'x-openwop-act-as': viewerMemberId });
    expect(seen).not.toContain(clientB);
    expect(seen).toContain(wsTenant);
  });

  it('a caller with no session sees nothing of the workspace', async () => {
    const r = await get<{ orgs?: { orgId: string }[] }>('/host/openwop-app/orgs');
    const ids = (r.body.orgs ?? []).map((o) => o.orgId);
    expect(ids).not.toContain(clientA);
    expect(ids).not.toContain(clientB);
  });

  it('an anonymous sandbox still sees the org it created', async () => {
    const sid = randomBytes(12).toString('hex');
    const anon = `anon:${sid}`;
    const own = (await createOrg({ tenantId: anon, createdBy: anon, name: 'Mine' })).orgId;
    const now = Math.floor(Date.now() / 1000);
    const cookie = `__session=${signSession({ sid, tenantId: anon, tier: 'anon', personalTenant: anon, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
    expect(await orgIds({ cookie })).toEqual([own]);
  });

  it('the Access hub counts the same orgs the caller can list', async () => {
    const s = await get<{ orgs?: { count: number } }>('/host/openwop-app/access/summary', { cookie: cookies.viewer });
    expect(s.status).toBe(200);
    expect(s.body.orgs?.count).toBe(2);
  });
});
