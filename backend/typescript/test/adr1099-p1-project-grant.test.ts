/**
 * ADR 1099 P1 (D3) — the `project` grant kind behind `projects.client-portal`.
 *
 * Over the host routes, with campaign-ops never switched on: a firm admin invites
 * a client (and a builder) to ONE project, the person accepts with their own
 * account and sees only that project's closed projection. The witness the ADR
 * names: invite, accept, expiry, revoke and the granter losing authority each end
 * in a uniform 404; a project in another org is a 404; the switch off refuses
 * everything. A project delete revokes its grants.
 *
 * Sabotage notes (each reds a case below):
 *  - dropping the org check in `projectInOrg` reds "another org's project";
 *  - `surface.enabledFor` returning true reds "the switch off";
 *  - adding a field to the projection reds "sees only the projection";
 *  - not registering the `collaboratorGrants` dependent reds "a project delete".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, deleteMember, listMembers } from '../src/host/accessControlService.js';
import { getUser } from '../src/features/users/usersService.js';
import { checkGrantUse, getGrant, type CollaboratorGrant } from '../src/host/externalCollaborators.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE } from '../src/features/projects/clientPortal.js';

let BASE: string;
let server: http.Server;

async function setPortal(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
  if (!d) throw new Error('projects.client-portal is not registered');
  await saveConfig({ ...d, status }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  await setPortal('on');
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
const G = (grantId: string): string => `/host/openwop-app/collab/grants/${grantId}`;

let n = 0;
/** A firm workspace with one org and a project in it. Campaign-ops stays off. */
async function firm() {
  const tenantId = `ws:t-1099p1-${n++}`;
  const admin = client();
  const a = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `owner-${n}@studio.test`, tenantId });
  expect(a.status, a.raw).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  expect(org.status, org.raw).toBe(201);
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  expect(p.status, p.raw).toBe(201);
  return { tenantId, orgId: org.body.orgId, projectId: p.body.id, admin, adminId: a.body.user.userId };
}

/** Invited over the host route, accepted with the person's own account. */
async function invited(f: { orgId: string; admin: Client }, kind: 'client-stakeholder' | 'vendor' = 'client-stakeholder') {
  const person = client();
  const v = await person.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `${kind}-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind, email, displayName: kind === 'vendor' ? 'Oak Builders' : 'Casey Client' });
  expect(inv.status, inv.raw).toBe(201);
  const acc = await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token });
  expect(acc.status, acc.raw).toBe(200);
  return { person, userId: v.body.user.userId, collaboratorId: inv.body.collaborator.collaboratorId };
}

async function grant(f: { orgId: string; admin: Client }, collaboratorId: string, projectId: string, actions = ['view', 'comment']) {
  return f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { resource: { kind: 'project', id: projectId }, actions, expiresInDays: 30 });
}

describe('ADR 1099 P1 — a project grant', () => {
  it('the switch is registered off by default, per tenant', () => {
    const d = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
    expect(d).toMatchObject({ status: 'off', bucketUnit: 'tenant' });
  });

  it('invite, accept, grant: the client sees only the projection, in "Shared with me" and by id', async () => {
    const f = await firm();
    const c = await invited(f);
    const g = await grant(f, c.collaboratorId, f.projectId);
    expect(g.status, g.raw).toBe(201);
    const view = await c.person.get<{ title: string; resource: Record<string, unknown>; grant: { actions: string[] } }>(G(g.body.grant.grantId));
    expect(view.status, view.raw).toBe(200);
    expect(view.body.title).toBe('Kitchen and bath');
    expect(view.body.resource).toEqual({ kind: 'project', name: 'Kitchen and bath' });
    expect(view.body.grant.actions).toEqual(['view', 'comment']);
    const shared = await c.person.get<{ items: Array<{ grantId: string; resourceKind: string }> }>('/host/openwop-app/collab/shared');
    expect(shared.body.items.map((i) => [i.grantId, i.resourceKind])).toEqual([[g.body.grant.grantId, 'project']]);
  });

  it('a builder (another firm) is granted the same shape', async () => {
    const f = await firm();
    const b = await invited(f, 'vendor');
    const g = await grant(f, b.collaboratorId, f.projectId);
    expect(g.status, g.raw).toBe(201);
    expect((await b.person.get(G(g.body.grant.grantId))).status).toBe(200);
  });

  it('only view and comment can be granted', async () => {
    const f = await firm();
    const c = await invited(f);
    expect((await grant(f, c.collaboratorId, f.projectId, ['view', 'upload'])).status).toBe(400);
    expect((await grant(f, c.collaboratorId, f.projectId, ['decide'])).status).toBe(400);
  });

  it('another org\'s project, and another tenant\'s, are a 404', async () => {
    const f = await firm();
    const c = await invited(f);
    const otherOrg = await f.admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Hillside' });
    const elsewhere = await f.admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: otherOrg.body.orgId, name: 'Hillside deck' });
    expect(elsewhere.status, elsewhere.raw).toBe(201);
    expect((await grant(f, c.collaboratorId, elsewhere.body.id)).status).toBe(404);
    const other = await firm();
    expect((await grant(f, c.collaboratorId, other.projectId)).status).toBe(404);
  });

  it('revoked, expired and a granter who lost authority: each next use is a 404', async () => {
    const f = await firm();
    const c = await invited(f);
    const g1 = await grant(f, c.collaboratorId, f.projectId);
    const rv = await f.admin.del(`${C(f.orgId)}/${c.collaboratorId}/grants/${g1.body.grant.grantId}`);
    expect(rv.status, rv.raw).toBe(200);
    expect((await c.person.get(G(g1.body.grant.grantId))).status).toBe(404);

    const g2 = await grant(f, c.collaboratorId, f.projectId);
    const at = Date.parse(g2.body.grant.expiresAt);
    await expect(checkGrantUse({ grantId: g2.body.grant.grantId, via: { userId: c.userId }, action: 'view', now: new Date(at - 60_000) })).resolves.toBeTruthy();
    await expect(checkGrantUse({ grantId: g2.body.grant.grantId, via: { userId: c.userId }, action: 'view', now: new Date(at + 1) })).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });

    // An admin who granted, then is demoted to a viewer in the org and the workspace.
    const adm = client();
    const login = await adm.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `admin2-${n++}@studio.test` });
    const uid = login.body.user.userId;
    await createMember({ tenantId: f.tenantId, orgId: f.tenantId, subject: uid, displayName: 'a2', roles: ['viewer'] });
    await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: uid, displayName: 'a2', roles: ['admin'] });
    expect((await adm.post(`/host/openwop-app/workspaces/${encodeURIComponent(f.tenantId)}/switch`)).status).toBe(200);
    const g3 = await adm.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${c.collaboratorId}/grants`, { resource: { kind: 'project', id: f.projectId }, actions: ['view'] });
    expect(g3.status, g3.raw).toBe(201);
    expect((await c.person.get(G(g3.body.grant.grantId))).status).toBe(200);
    for (const m of await listMembers(f.tenantId, f.orgId)) if (m.subject === uid) await deleteMember(m.memberId);
    await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: uid, displayName: 'a2', roles: ['viewer'] });
    expect((await c.person.get(G(g3.body.grant.grantId))).status).toBe(404);
  });

  it('an editor who is not an admin can neither invite nor grant', async () => {
    const f = await firm();
    const c = await invited(f);
    const ed = client();
    const login = await ed.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `editor-${n++}@studio.test` });
    const uid = login.body.user.userId;
    await createMember({ tenantId: f.tenantId, orgId: f.tenantId, subject: uid, displayName: 'ed', roles: ['viewer'] });
    await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: uid, displayName: 'ed', roles: ['editor'] });
    expect((await ed.post(`/host/openwop-app/workspaces/${encodeURIComponent(f.tenantId)}/switch`)).status).toBe(200);
    expect((await ed.post(`${C(f.orgId)}/${c.collaboratorId}/grants`, { resource: { kind: 'project', id: f.projectId }, actions: ['view'] })).status).toBe(404);
    expect((await ed.post(C(f.orgId), { kind: 'client-stakeholder', email: 'z@outside.test', displayName: 'Z' })).status).toBe(404);
  });

  it('a project delete revokes its grants, and the preview counts them', async () => {
    const f = await firm();
    const c = await invited(f);
    const g = await grant(f, c.collaboratorId, f.projectId);
    const preview = await f.admin.get<{ dependents: Record<string, number> }>(`/host/openwop-app/projects/${f.projectId}/delete-preview`);
    expect(preview.body.dependents.collaboratorGrants).toBe(1);
    const del = await f.admin.del(`/host/openwop-app/projects/${f.projectId}`);
    expect([200, 204]).toContain(del.status);
    expect((await getGrant(f.tenantId, f.orgId, g.body.grant.grantId))?.status).toBe('revoked');
    expect((await c.person.get(G(g.body.grant.grantId))).status).toBe(404);
  });

  // Last: it flips the global switch.
  it('the switch off: nothing to grant, no invite, no mint, and a live grant goes dark', async () => {
    const f = await firm();
    const c = await invited(f);
    const g = await grant(f, c.collaboratorId, f.projectId);
    expect(g.status, g.raw).toBe(201);
    const on = await f.admin.get<{ kinds: Array<{ kind: string }> }>(`${C(f.orgId)}/grantable`);
    expect(on.body.kinds.map((k) => k.kind)).toContain('project');
    await setPortal('off');
    try {
      expect((await f.admin.get<{ kinds: Array<{ kind: string }> }>(`${C(f.orgId)}/grantable`)).body.kinds.map((k) => k.kind)).not.toContain('project');
      expect((await grant(f, c.collaboratorId, f.projectId)).status).toBe(404);
      expect((await f.admin.post(C(f.orgId), { kind: 'client-stakeholder', email: 'q@outside.test', displayName: 'Q' })).status).toBe(404);
      expect((await c.person.get(G(g.body.grant.grantId))).status).toBe(404);
      expect((await c.person.get<{ items: unknown[] }>('/host/openwop-app/collab/shared')).body.items).toEqual([]);
    } finally {
      await setPortal('on');
    }
  });
});
