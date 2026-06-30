/**
 * Strategy (ADR 0079) — ROUTE harness. Boots the real app and drives the feature
 * over HTTP:
 *   - toggle gating (404 when `strategy` is off)
 *   - create (default org scope) / get / list
 *   - cross-org IDOR: a member of org A cannot read an org-B strategy (404, no leak)
 *   - user-scope privacy: only the creator reads a user-scoped strategy
 *   - workspace-scope broad read: any tenant member with workspace:read reads it
 *   - config authority: a co-tenant editor can rename but not change scope/archive;
 *     the creator can
 *   - links: link a readable project (200), an unreadable project (403);
 *     context projection omits an unreadable linked entity
 *   - archive vs hard-delete: shared ⇒ archived; hard-delete shared ⇒ 400;
 *     hard-delete a user-scoped draft ⇒ 204
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await enable('on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('strat'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('strategy'); if (d) await saveConfig({ ...d, status }, 'test'); };
const enableToggle = async (id: string): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

const S = '/v1/host/openwop-app/strategy';
const mkOrg = (c: Client, name: string) => c.post('/v1/host/openwop-app/orgs', { name });
const addMember = (owner: Client, orgId: string, subject: string, roles: string[]) =>
  owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject, roles });

/** A tenant with an owner + one org. */
async function ownerWithOrg(tenantId: string): Promise<{ owner: Client; userId: string; orgId: string }> {
  const owner = client();
  const u = await signup(owner, { tenantId });
  const org = await mkOrg(owner, 'Acme');
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, userId: u.userId, orgId: org.body.orgId };
}
const freshTenant = (): string => `org:strat-${Date.now()}-${n++}`;

describe('strategy — toggle gating', () => {
  it('404s every route when the toggle is off, 200 once on', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await enable('off');
    expect((await owner.get(S)).status).toBe(404);
    expect((await owner.post(S, { orgId, title: 'X' })).status).toBe(404);
    await enable('on');
    expect((await owner.get(S)).status).toBe(200);
  });
});

describe('strategy — CRUD + defaults', () => {
  it('creates with org-scope/annual defaults, gets, and lists', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    const created = await owner.post(S, { orgId, title: 'North Star', summary: 'Win the market', objectives: [{ title: 'Grow ARR', keyResults: [{ title: 'ARR 10M', target: '10M' }] }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.scope).toBe('org');
    expect(created.body.planningHorizon).toBe('annual');
    expect(created.body.status).toBe('draft');
    expect(created.body.objectives[0].keyResults[0].id).toBeTruthy();

    const got = await owner.get(`${S}/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.title).toBe('North Star');

    const list = await owner.get(S);
    expect(list.body.strategies.map((x: any) => x.id)).toContain(created.body.id);
  });

  it('rejects an unknown scope/horizon with validation_error', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    expect((await owner.post(S, { orgId, title: 'Bad', scope: 'galaxy' })).status).toBe(400);
    expect((await owner.post(S, { orgId, title: 'Bad', planningHorizon: 'fortnight' })).status).toBe(400);
    expect((await owner.post(S, { orgId, title: '' })).status).toBe(400);
  });
});

describe('strategy — cross-org IDOR', () => {
  it('a member of org A cannot read an org-B strategy (404, not in index)', async () => {
    const tenantId = freshTenant();
    const owner = client(); await signup(owner, { tenantId });
    const member = client(); const memberUser = await signup(member, { tenantId });
    const orgA = (await mkOrg(owner, 'Alpha')).body.orgId;
    const orgB = (await mkOrg(owner, 'Bravo')).body.orgId;
    await addMember(owner, orgA, memberUser.userId, ['editor']);

    const sB = (await owner.post(S, { orgId: orgB, title: 'B-only', scope: 'org' })).body;
    expect((await member.get(`${S}/${sB.id}`)).status).toBe(404);
    expect((await member.get(S)).body.strategies.map((x: any) => x.id)).not.toContain(sB.id);
    // The tenant owner (scope in every org) can.
    expect((await owner.get(`${S}/${sB.id}`)).status).toBe(200);
  });
});

describe('strategy — scope visibility', () => {
  it('user-scope is private to the creator; workspace-scope is readable tenant-wide', async () => {
    const tenantId = freshTenant();
    const owner = client(); await signup(owner, { tenantId });
    const member = client(); const memberUser = await signup(member, { tenantId });
    const orgA = (await mkOrg(owner, 'Alpha')).body.orgId;
    const orgB = (await mkOrg(owner, 'Bravo')).body.orgId;
    // member is an editor in org B only.
    await addMember(owner, orgB, memberUser.userId, ['editor']);

    // user-scoped draft owned in org A by the owner — member can't read it.
    const priv = (await owner.post(S, { orgId: orgA, title: 'Secret', scope: 'user' })).body;
    expect((await member.get(`${S}/${priv.id}`)).status).toBe(404);
    expect((await owner.get(`${S}/${priv.id}`)).status).toBe(200);

    // workspace-scoped in org A — the member (reader somewhere in the tenant) CAN read it.
    const wide = (await owner.post(S, { orgId: orgA, title: 'Company plan', scope: 'workspace' })).body;
    expect((await member.get(`${S}/${wide.id}`)).status).toBe(200);
  });
});

describe('strategy — config authority + archive/delete', () => {
  it('a co-tenant editor can rename but not change scope/archive; the creator can', async () => {
    const tenantId = freshTenant();
    const owner = client(); await signup(owner, { tenantId });
    const member = client(); const memberUser = await signup(member, { tenantId });
    const orgId = (await mkOrg(owner, 'Acme')).body.orgId;
    await addMember(owner, orgId, memberUser.userId, ['editor']);
    const s = (await owner.post(S, { orgId, title: 'Plan', scope: 'org' })).body;

    // editor (workspace:write) may rename + set the descriptive accountable exec
    expect((await member.patch(`${S}/${s.id}`, { title: 'Plan v2' })).body.title).toBe('Plan v2');
    expect((await member.patch(`${S}/${s.id}`, { accountableExecutive: 'CFO' })).body.accountableExecutive).toBe('CFO');
    // editor may NOT flip scope (config authority) or archive
    expect((await member.patch(`${S}/${s.id}`, { scope: 'workspace' })).status).toBe(403);
    expect((await member.del(`${S}/${s.id}`)).status).toBe(403);
    // creator/owner can
    expect((await owner.patch(`${S}/${s.id}`, { scope: 'workspace' })).body.scope).toBe('workspace');
  });

  it('DELETE soft-archives a shared strategy by default; an authorized hard-delete removes it; user drafts hard-delete', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    const shared = (await owner.post(S, { orgId, title: 'Shared', scope: 'org' })).body;
    const archived = await owner.del(`${S}/${shared.id}`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    // archived rows drop out of the default index but remain fetchable
    expect((await owner.get(S)).body.strategies.map((x: any) => x.id)).not.toContain(shared.id);
    expect((await owner.get(`${S}?includeArchived=true`)).body.strategies.map((x: any) => x.id)).toContain(shared.id);
    // hard-delete IS permitted for a shared strategy by a config-authority caller
    // (creator / org admin); soft-archive is just the no-`hard` default.
    expect((await owner.del(`${S}/${shared.id}?hard=true`)).status).toBe(204);
    expect((await owner.get(`${S}/${shared.id}`)).status).toBe(404);

    const draft = (await owner.post(S, { orgId, title: 'Draft', scope: 'user' })).body;
    expect((await owner.del(`${S}/${draft.id}?hard=true`)).status).toBe(204);
    expect((await owner.get(`${S}/${draft.id}`)).status).toBe(404);
  });
});

describe('strategy — links + context projection', () => {
  it('links a readable project, refuses an unreadable one, and context omits unreadable targets', async () => {
    const tenantId = freshTenant();
    const owner = client(); await signup(owner, { tenantId });
    const member = client(); const memberUser = await signup(member, { tenantId });
    const orgA = (await mkOrg(owner, 'Alpha')).body.orgId;
    const orgB = (await mkOrg(owner, 'Bravo')).body.orgId;
    await addMember(owner, orgA, memberUser.userId, ['editor']);

    const projA = (await owner.post('/v1/host/openwop-app/projects', { orgId: orgA, name: 'Apollo' })).body;
    const projB = (await owner.post('/v1/host/openwop-app/projects', { orgId: orgB, name: 'Borealis' })).body;

    // member creates a workspace-scoped strategy in org A (their editable org).
    const s = (await member.post(S, { orgId: orgA, title: 'Roadmap', scope: 'workspace' })).body;
    // link the readable project A → 200
    const linked = await member.put(`${S}/${s.id}/links`, { links: [{ kind: 'project', projectId: projA.id }] });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.links).toHaveLength(1);
    // linking project B (unreadable to the member) → 403
    expect((await member.put(`${S}/${s.id}/links`, { links: [{ kind: 'project', projectId: projB.id }] })).status).toBe(403);

    // context for project A includes the strategy + the linked project
    const ctx = await member.get(`${S}/context?projectId=${projA.id}`);
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    expect(ctx.body.strategies).toHaveLength(1);
    expect(ctx.body.strategies[0].linkedProjects.map((p: any) => p.id)).toContain(projA.id);

    // owner cross-links project B onto the same strategy; the member's context omits it
    expect((await owner.put(`${S}/${s.id}/links`, { links: [{ kind: 'project', projectId: projA.id }, { kind: 'project', projectId: projB.id }] })).status).toBe(200);
    const ctx2 = await member.get(`${S}/context?projectId=${projA.id}`);
    const ids = ctx2.body.strategies[0].linkedProjects.map((p: any) => p.id);
    expect(ids).toContain(projA.id);
    expect(ids).not.toContain(projB.id); // unreadable → silently omitted
  });

  it('a priority-idea link surfaces in GET /strategy/context?priorityListId (Phase 3 contract)', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await enableToggle('priority-matrix');
    // a priority list + an idea (kanban card) in the same org
    const PM = '/v1/host/openwop-app/priority-matrix';
    const list = (await owner.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body;
    expect(list.id).toBeTruthy();
    await owner.post(`${PM}/lists/${encodeURIComponent(list.id)}/ideas`, { title: 'Expand to EU' });
    const ranked = (await owner.get(`${PM}/lists/${encodeURIComponent(list.id)}/ideas`)).body.ideas;
    const cardId = ranked[0].card.id;

    const s = (await owner.post(S, { orgId, title: 'Growth', scope: 'org' })).body;
    expect((await owner.put(`${S}/${s.id}/links`, { links: [{ kind: 'priority-idea', listId: list.id, cardId }] })).status).toBe(200);

    // context by list → the strategy, with the idea under linkedPriorities
    const byList = await owner.get(`${S}/context?priorityListId=${encodeURIComponent(list.id)}`);
    expect(byList.status, JSON.stringify(byList.body)).toBe(200);
    expect(byList.body.strategies.map((x: any) => x.id)).toContain(s.id);
    const entry = byList.body.strategies.find((x: any) => x.id === s.id);
    expect(entry.linkedPriorities.some((lp: any) => lp.cardId === cardId && lp.listId === list.id)).toBe(true);

    // context by idea → same strategy
    const byIdea = await owner.get(`${S}/context?priorityListId=${encodeURIComponent(list.id)}&cardId=${encodeURIComponent(cardId)}`);
    expect(byIdea.body.strategies.map((x: any) => x.id)).toContain(s.id);
  });

  it('a private linked project (ADR 0054) is NOT leaked in context to a non-member org reader', async () => {
    const tenantId = freshTenant();
    const owner = client(); await signup(owner, { tenantId });
    const reader = client(); const readerUser = await signup(reader, { tenantId });
    const orgId = (await mkOrg(owner, 'Acme')).body.orgId;
    // reader is a read-only org member (workspace:read, NOT workspace:write —
    // write authority would grant project access regardless of visibility) and
    // NOT a project member, so a `private` project is unreadable to them.
    await addMember(owner, orgId, readerUser.userId, ['viewer']);

    // a PRIVATE project owned by the owner; a workspace-scoped strategy links it
    // (visibility is set via its own route — create defaults to 'org')
    const proj = (await owner.post('/v1/host/openwop-app/projects', { orgId, name: 'Skunkworks' })).body;
    expect((await owner.patch(`/v1/host/openwop-app/projects/${proj.id}/visibility`, { visibility: 'private' })).status).toBe(200);
    const s = (await owner.post(S, { orgId, title: 'Bet', scope: 'workspace' })).body;
    expect((await owner.put(`${S}/${s.id}/links`, { links: [{ kind: 'project', projectId: proj.id }] })).status).toBe(200);

    // the owner (project creator/writer) sees the project in context
    const ownerCtx = await owner.get(`${S}/context?projectId=${proj.id}`);
    expect(ownerCtx.body.strategies[0].linkedProjects.map((p: any) => p.id)).toContain(proj.id);

    // the reader can read the workspace-scoped strategy, but the private project
    // (member-scoped) MUST be omitted from its linkedProjects — no name/health leak
    const readerCtx = await reader.get(`${S}/context?projectId=${proj.id}`);
    expect(readerCtx.status).toBe(200);
    const entry = readerCtx.body.strategies.find((x: any) => x.id === s.id);
    if (entry) expect(entry.linkedProjects.map((p: any) => p.id)).not.toContain(proj.id);
  });
});
