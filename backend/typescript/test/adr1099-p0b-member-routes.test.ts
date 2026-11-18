/**
 * ADR 1099 P0b — the firm's collaborator routes in the host (the rest of D2), and
 * a grant kind's own grant scope with its floor.
 *
 * P0 moved the collaborator's side to the host; the firm's side (invite, grant,
 * revoke, grantable, audit) stayed behind campaign-ops' toggles and a client
 * account, so a kind with its own surface could be USED but never MINTED by a
 * person. Here campaign-ops is never switched on: a kind that brings its own
 * surface and `grantScope: 'workspace:write'` is invited, granted by an editor,
 * viewed and revoked over the host routes. Who may grant is the kind's scope,
 * re-checked for the granter on every use; nothing below `workspace:write` can
 * ever be a kind's grant scope; every grant and revoke is audited with its
 * granter and kind.
 *
 * Sabotage notes (each reds a case below):
 *  - the grant route authorizing with `host:members:manage` instead of the kind's
 *    scope reds "an editor grants" (the editor is refused);
 *  - dropping the grant route's authority check reds "a viewer … cannot grant";
 *  - the per-use granter re-check using the default scope instead of the kind's
 *    reds "an editor grants" (the editor's grant is refused on view);
 *  - removing the floor in `registerGrantResourceKind` reds "the floor";
 *  - dropping `by` from the grant or revoke audit reds "audited".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, deleteMember, listMembers } from '../src/host/accessControlService.js';
import { getUser } from '../src/features/users/usersService.js';
import { registerGrantResourceKind, type CollaboratorGrant } from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;
const probeOn = new Set<string>();
const probeOrgs = new Set<string>();
const PROBE = 'p0b-probe';

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
  const tenantId = `ws:t-1099b-${n++}`;
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
  return { vendor, collaboratorId: inv.body.collaborator.collaboratorId };
}

const grantBody = (actions: string[] = ['view', 'mark-ready']) => ({ resource: { kind: PROBE, id: 'po-1' }, actions });

describe('ADR 1099 P0b — the firm side in the host, with campaign-ops off', () => {
  it('an editor grants a kind whose grant scope is workspace:write; the vendor sees it; the editor revokes it', async () => {
    const f = await firm();
    const { vendor, collaboratorId } = await invitedVendor(f);
    const ed = await member(f, 'editor');
    const g = await ed.http.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody());
    expect(g.status, g.raw).toBe(201);
    expect(g.body.grant.createdBy).toBe(ed.userId);
    const view = await vendor.get<{ title: string; resource: Record<string, unknown> }>(`/host/openwop-app/collab/grants/${g.body.grant.grantId}`);
    expect(view.status, view.raw).toBe(200);
    expect(view.body).toMatchObject({ title: 'Purchase order 1042', resource: { lines: 3 } });
    const rv = await ed.http.del(`${C(f.orgId)}/${collaboratorId}/grants/${g.body.grant.grantId}`);
    expect(rv.status, rv.raw).toBe(200);
    expect((await vendor.get(`/host/openwop-app/collab/grants/${g.body.grant.grantId}`)).status).toBe(404);
  });

  it('the grantable picker offers the kind to an editor, and not once its surface is off', async () => {
    const f = await firm();
    const ed = await member(f, 'editor');
    const on = await ed.http.get<{ kinds: Array<{ kind: string; items: Array<{ id: string }> }> }>(`${C(f.orgId)}/grantable`);
    expect(on.status, on.raw).toBe(200);
    expect(on.body.kinds.map((k) => k.kind)).toEqual([PROBE]);
    probeOn.delete(f.tenantId);
    const off = await ed.http.get<{ kinds: unknown[] }>(`${C(f.orgId)}/grantable`);
    expect(off.body.kinds).toEqual([]);
  });

  it('a viewer, a non-member and another tenant cannot grant, and an editor cannot invite', async () => {
    const f = await firm();
    const { collaboratorId } = await invitedVendor(f);
    const viewer = await member(f, 'viewer');
    expect((await viewer.http.post(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody())).status).toBe(404);
    expect((await viewer.http.get<{ kinds: unknown[] }>(`${C(f.orgId)}/grantable`)).body.kinds).toEqual([]);
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${n++}@else.test` });
    expect((await stranger.post(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody())).status).toBe(404);
    const other = await firm();
    expect((await other.admin.post(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody())).status).toBe(404);
    const ed = await member(f, 'editor');
    expect((await ed.http.post(C(f.orgId), { kind: 'vendor', email: 'x@mill.test', displayName: 'X' })).status).toBe(404);
  });

  it('an action outside the kind (upload, decide) is refused at the mint', async () => {
    const f = await firm();
    const { collaboratorId } = await invitedVendor(f);
    const r = await f.admin.post<{ error: string }>(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody(['view', 'upload']));
    expect(r.status, r.raw).toBe(400);
    expect((await f.admin.post(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody(['decide']))).status).toBe(400);
  });

  it('the surface off refuses the mint and darkens a grant; the org closed refuses the invite', async () => {
    const f = await firm();
    const { vendor, collaboratorId } = await invitedVendor(f);
    const g = await f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody());
    expect(g.status, g.raw).toBe(201);
    probeOn.delete(f.tenantId);
    expect((await f.admin.post(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody())).status).toBe(404);
    expect((await vendor.get(`/host/openwop-app/collab/grants/${g.body.grant.grantId}`)).status).toBe(404);
    probeOn.add(f.tenantId);
    probeOrgs.delete(`${f.tenantId}:${f.orgId}`);
    expect((await f.admin.post(C(f.orgId), { kind: 'vendor', email: 'y@mill.test', displayName: 'Y' })).status).toBe(404);
  });

  it('a granter demoted below the kind\'s scope: the next use is refused', async () => {
    const f = await firm();
    const { vendor, collaboratorId } = await invitedVendor(f);
    const ed = await member(f, 'editor');
    const g = await ed.http.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody());
    expect(g.status, g.raw).toBe(201);
    expect((await vendor.get(`/host/openwop-app/collab/grants/${g.body.grant.grantId}`)).status).toBe(200);
    for (const m of await listMembers(f.tenantId, f.orgId)) if (m.subject === ed.userId) await deleteMember(m.memberId);
    await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: ed.userId, displayName: 'editor', roles: ['viewer'] });
    expect((await vendor.get(`/host/openwop-app/collab/grants/${g.body.grant.grantId}`)).status).toBe(404);
  });

  it('audited: every grant and revoke names its granter and its kind', async () => {
    const f = await firm();
    const { collaboratorId } = await invitedVendor(f);
    const ed = await member(f, 'editor');
    const g = await ed.http.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, grantBody());
    await f.admin.del(`${C(f.orgId)}/${collaboratorId}/grants/${g.body.grant.grantId}`);
    const a = await f.admin.get<{ events: Array<{ action: string; grantId?: string; by?: string; resource?: { kind: string } }> }>(`${C(f.orgId)}/audit`);
    expect(a.status, a.raw).toBe(200);
    const mine = a.body.events.filter((e) => e.grantId === g.body.grant.grantId).map((e) => ({ action: e.action, by: e.by, kind: e.resource?.kind }));
    expect(mine).toEqual([
      { action: 'grant.revoke', by: f.adminId, kind: PROBE },
      { action: 'grant.create', by: ed.userId, kind: PROBE },
    ]);
  });

  it('the campaign-ops agency routes still need campaign-ops on (unchanged)', async () => {
    const f = await firm();
    const r = await f.admin.get(`/host/openwop-app/campaign-ops/clients/${f.orgId}/collaborators`);
    expect(r.status, r.raw).not.toBe(200);
    expect((await f.admin.get(C(f.orgId))).status, 'control: the host route serves the same org').toBe(200);
  });
});

describe('ADR 1099 P0b — the grant-scope floor', () => {
  const def = (grantScope: string) => ({
    featureId: null, actions: ['view'] as const, async exists() { return true; }, async project() { return null; },
    grantScope: grantScope as 'workspace:write',
  });
  it('refuses any grant scope below workspace:write, and accepts workspace:write and management scopes', () => {
    for (const low of ['workspace:read', 'runs:read', 'runs:create', 'approvals:respond', 'host:comments:write', 'not-a-scope']) {
      expect(() => registerGrantResourceKind('p0b-floor', def(low)), low).toThrow(/below the floor/);
    }
    for (const ok of ['workspace:write', 'host:members:manage']) {
      expect(() => registerGrantResourceKind(`p0b-ok-${ok.replace(/[^a-z]/g, '')}`, def(ok)), ok).not.toThrow();
    }
  });
});
