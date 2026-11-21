/**
 * ADR 0958 Q1 (decided 2026-11-19, the user) — a grant is renewed, never capped
 * in total. Each grant lasts at most 180 days counted from its last renewal; a
 * member holding the kind's grant scope renews it as often as needed; nothing
 * never expires.
 *
 * Pinned here, over the host route and the seam:
 * - a renewal keeps the grant id, moves `expiresAt`, re-arms the expiry notice,
 *   makes the renewer the grant's `createdBy` and is audited `grant.extend` with `by`;
 * - a renewal past 180 days from today, one that ends no later than now, a revoked
 *   grant and an expired grant are each refused;
 * - a viewer cannot renew; the kind's switch off refuses it;
 * - repeated renewals keep a grant alive past 180 days in total (no lifetime cap);
 * - after the original granter leaves, the renewer's standing keeps the grant usable.
 *
 * Sabotage notes (each reds a case): no 180-day bound on a renewal; no
 * authority check on the route; renewing a revoked grant; leaving `createdBy`
 * as the original granter.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, deleteMember, listMembers } from '../src/host/accessControlService.js';
import { getUser } from '../src/features/users/usersService.js';
import { checkGrantUse, extendGrant, grantAccess, registerGrantResourceKind, revokeGrant, type CollaboratorGrant } from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;
const probeOn = new Set<string>();
const probeOrgs = new Set<string>();
const PROBE = 'q1-renew-probe';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // Only `users`: campaign-ops and its external-collab toggle stay OFF throughout.
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  registerGrantResourceKind(PROBE, {
    featureId: null,
    actions: ['view', 'comment', 'mark-ready'],
    grantScope: 'workspace:write',
    async exists() { return true; },
    async project() { return { title: 'Purchase order 1042', body: { lines: 3 } }; },
    async list() { return [{ id: 'po-1', title: 'Purchase order 1042' }]; },
    surface: {
      async enabledFor(tenantId) { return probeOn.has(tenantId); },
      async orgOpen(tenantId, orgId) { return probeOrgs.has(`${tenantId}:${orgId}`); },
    },
  });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;

let n = 0;
/** A firm workspace and an org with NO campaign-ops client, under the probe surface. */
async function firm() {
  const tenantId = `ws:t-0958q1-${n++}`;
  const admin = client();
  const a = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `owner-${n}@firm.test`, tenantId });
  expect(a.status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const orgId = org.body.orgId;
  probeOn.add(tenantId);
  probeOrgs.add(`${tenantId}:${orgId}`);
  return { tenantId, orgId, admin, adminId: a.body.user.userId };
}

/** A person who arrives the production way: personal login, member rows under
 *  the home userId (a viewer of the workspace, `role` in the org), then a switch. */
async function member(f: { tenantId: string; orgId: string }, role: 'viewer' | 'editor') {
  const http = client();
  const login = await http.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `${role}-${n++}@firm.test` });
  expect(login.status).toBe(201);
  const userId = login.body.user.userId;
  await createMember({ tenantId: f.tenantId, orgId: f.tenantId, subject: userId, displayName: role, roles: ['viewer'] });
  await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: userId, displayName: role, roles: [role] });
  const sw = await http.post(`/host/openwop-app/workspaces/${encodeURIComponent(f.tenantId)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return { http, userId };
}

/** The firm admin invites over the host route; the vendor accepts over the host route. */
async function invitedVendor(f: { orgId: string; admin: Client }) {
  const vendor = client();
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `vendor-${n++}@mill.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind: 'vendor', email, displayName: 'Mill Works' });
  expect(inv.status, inv.raw).toBe(201);
  const acc = await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token });
  expect(acc.status, acc.raw).toBe(200);
  return { vendor, vendorId: v.body.user.userId, collaboratorId: inv.body.collaborator.collaboratorId };
}

const grantBody = (actions: string[] = ['view', 'mark-ready']) => ({ resource: { kind: PROBE, id: 'po-1' }, actions });


const DAY = 24 * 60 * 60 * 1000;

describe('ADR 0958 Q1 — renewing a grant', () => {
  it('an editor renews: same id, later expiry, notice re-armed, renewer recorded and audited', async () => {
    const f = await firm();
    const { vendor, collaboratorId } = await invitedVendor(f);
    const ed = await member(f, 'editor');
    const g = await f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { ...grantBody(), expiresInDays: 10 });
    expect(g.status, g.raw).toBe(201);
    const r = await ed.http.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants/${g.body.grant.grantId}/extend`, { expiresInDays: 90 });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.grant.grantId).toBe(g.body.grant.grantId);
    expect(Date.parse(r.body.grant.expiresAt)).toBeGreaterThan(Date.parse(g.body.grant.expiresAt));
    expect(r.body.grant.createdBy).toBe(ed.userId);
    expect(r.body.grant.expiryNoticeAt).toBeUndefined();
    expect((await vendor.get(`/host/openwop-app/collab/grants/${g.body.grant.grantId}`)).status).toBe(200);
    const a = await f.admin.get<{ events: Array<{ action: string; grantId?: string; by?: string }> }>(`${C(f.orgId)}/audit`);
    expect(a.body.events.find((e) => e.action === 'grant.extend' && e.grantId === g.body.grant.grantId)?.by).toBe(ed.userId);
  });

  it('refuses more than 180 days from today, a renewal that ends no later, and a viewer', async () => {
    const f = await firm();
    const { collaboratorId } = await invitedVendor(f);
    const g = await f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { ...grantBody(), expiresInDays: 60 });
    const X = `${C(f.orgId)}/${collaboratorId}/grants/${g.body.grant.grantId}/extend`;
    expect((await f.admin.post(X, { expiresInDays: 181 })).status).toBe(400);
    const notLater = await f.admin.post<{ details?: { reason?: string } }>(X, { expiresInDays: 30 });
    expect(notLater.status).toBe(400);
    expect(notLater.body.details?.reason).toBe('expiry_not_later');
    const viewer = await member(f, 'viewer');
    expect((await viewer.http.post(X, { expiresInDays: 120 })).status).toBe(404);
    probeOn.delete(f.tenantId);
    expect((await f.admin.post(X, { expiresInDays: 120 })).status).toBe(404);
  });

  it('a revoked or an expired grant is not renewed (grant access again instead)', async () => {
    const f = await firm();
    const { collaboratorId } = await invitedVendor(f);
    const revoked = await grantAccess({ tenantId: f.tenantId, orgId: f.orgId, collaboratorId, resource: { kind: PROBE, id: 'po-1' }, actions: ['view'], createdBy: f.adminId });
    await revokeGrant(f.tenantId, f.orgId, revoked.grantId, f.adminId);
    await expect(extendGrant({ tenantId: f.tenantId, orgId: f.orgId, grantId: revoked.grantId, expiresInDays: 30, actor: f.adminId })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'grant_revoked' } });
    const lapsed = await grantAccess({ tenantId: f.tenantId, orgId: f.orgId, collaboratorId, resource: { kind: PROBE, id: 'po-1' }, actions: ['view'], expiresInDays: 1, createdBy: f.adminId });
    await expect(extendGrant({ tenantId: f.tenantId, orgId: f.orgId, grantId: lapsed.grantId, expiresInDays: 30, actor: f.adminId, now: new Date(Date.now() + 2 * DAY) })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'grant_expired' } });
  });

  it('there is no lifetime cap: renewals keep a grant alive past 180 days in total', async () => {
    const f = await firm();
    const { collaboratorId } = await invitedVendor(f);
    let g = await grantAccess({ tenantId: f.tenantId, orgId: f.orgId, collaboratorId, resource: { kind: PROBE, id: 'po-1' }, actions: ['view'], expiresInDays: 180, createdBy: f.adminId });
    const created = Date.parse(g.createdAt);
    const at = new Date(created + 170 * DAY);
    g = await extendGrant({ tenantId: f.tenantId, orgId: f.orgId, grantId: g.grantId, expiresInDays: 180, actor: f.adminId, now: at });
    expect(Date.parse(g.expiresAt) - created).toBeGreaterThan(300 * DAY);
  });

  it('the renewer becomes the granter the grant is re-checked against', async () => {
    const f = await firm();
    const { vendorId, collaboratorId } = await invitedVendor(f);
    const first = await member(f, 'editor');
    const second = await member(f, 'editor');
    const g = await first.http.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { ...grantBody(), expiresInDays: 10 });
    expect((await second.http.post(`${C(f.orgId)}/${collaboratorId}/grants/${g.body.grant.grantId}/extend`, { expiresInDays: 60 })).status).toBe(200);
    // The first editor leaves the org; the grant stands on the second editor's authority.
    for (const m of await listMembers(f.tenantId, f.orgId)) if (m.subject === first.userId) await deleteMember(m.memberId);
    for (const m of await listMembers(f.tenantId, f.tenantId)) if (m.subject === first.userId) await deleteMember(m.memberId);
    await expect(checkGrantUse({ grantId: g.body.grant.grantId, via: { userId: vendorId }, action: 'view' })).resolves.toBeDefined();
  });
});

