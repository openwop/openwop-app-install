/**
 * Priority Matrix (ADR 0058) — ROUTE harness. Boots the real app and drives the
 * feature over HTTP:
 *   - toggle gating (404 when `priority-matrix` is off)
 *   - create/list/get a list; optional project scoping (good + bad project)
 *   - submit ideas (kanban cards), score them, ranking reflects weighted scores
 *   - config authority: a co-tenant editor can't change criteria/weights (403);
 *     the list owner can
 *   - status move (column change) with no workflow side effect
 *   - planning session → agenda contains the top idea (documents OFF ⇒ inline md)
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
  const d = getToggleDefault('priority-matrix');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
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
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pm'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('priority-matrix'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function ownerWithOrg(): Promise<{ owner: Client; userId: string; orgId: string }> {
  const owner = client();
  const u = await signup(owner);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, userId: u.userId, orgId: org.body.orgId };
}

const L = '/v1/host/openwop-app/priority-matrix/lists';
// Default "weighted" preset criterion ids (ADR 0058 CRITERIA_PRESETS.weighted).
const HIGH = { 'strategic-alignment': 10, roi: 10, urgency: 10, 'compliance-risk': 10, cost: 1 };
const LOW = { 'strategic-alignment': 1, roi: 1, urgency: 1, 'compliance-risk': 1, cost: 10 };

describe('priority-matrix — toggle gating', () => {
  it('404s when the toggle is off', async () => {
    await enable('off');
    const c = client();
    await signup(c);
    expect((await c.get(L)).status).toBe(404);
    await enable('on');
  });
});

describe('priority-matrix — lists + scoping', () => {
  it('creates, lists, and gets a workspace-scoped list seeded with the preset', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(L, { orgId, name: 'Strategic Initiatives', presetId: 'weighted' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.name).toBe('Strategic Initiatives');
    expect(r.body.boardId).toBeTruthy();
    expect(r.body.criteriaSet.criteria.length).toBeGreaterThan(0);
    expect(r.body.projectId).toBeUndefined();
    const list = await owner.get(L);
    expect(list.body.lists).toHaveLength(1);
    const got = await owner.get(`${L}/${encodeURIComponent(r.body.id)}`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe('Strategic Initiatives');
  });

  it('scopes a list to a project, and 404s a bogus project', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const proj = await owner.post('/v1/host/openwop-app/projects', { orgId, name: 'Launch Q3' });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);
    const ok = await owner.post(L, { orgId, name: 'Launch priorities', projectId: proj.body.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.projectId).toBe(proj.body.id);
    const bad = await owner.post(L, { orgId, name: 'Bad', projectId: 'project-nope' });
    expect(bad.status).toBe(404);
  });
});

describe('priority-matrix — ideas + weighted ranking', () => {
  it('ranks a high-scored idea above a low-scored one', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Backlog', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const a = (await owner.post(`${base}/ideas`, { title: 'High value' })).body;
    const b = (await owner.post(`${base}/ideas`, { title: 'Low value' })).body;
    expect(a.id).toBeTruthy();
    // Score them.
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(a.id)}/scores`, { scores: HIGH })).status).toBe(200);
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(b.id)}/scores`, { scores: LOW })).status).toBe(200);
    const ranked = (await owner.get(`${base}/ideas`)).body.ideas;
    expect(ranked).toHaveLength(2);
    expect(ranked[0].card.title).toBe('High value');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].computedPriority).toBeGreaterThan(ranked[1].computedPriority);
  });

  it('moves an idea through statuses without firing a workflow', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Flow', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Move me' })).body;
    const moved = await owner.patch(`${base}/ideas/${encodeURIComponent(idea.id)}/status`, { columnId: 'in-process' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.columnId).toBe('in-process');
    expect(moved.body.lastRunId).toBeUndefined();
  });
});

describe('priority-matrix — config authority', () => {
  it('a co-tenant editor cannot change criteria/weights; the owner can', async () => {
    const tenantId = `org:pm-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'Guarded', presetId: 'weighted' })).body;

    const newSet = { aggregation: 'weighted-sum', criteria: [{ name: 'Only one', weight: 9, direction: 'benefit' }] };
    // Editor may read but not rewrite the scoring model.
    expect((await member.patch(`${L}/${encodeURIComponent(list.id)}`, { criteriaSet: newSet })).status).toBe(403);
    // Owner (creator) can.
    const ok = await owner.patch(`${L}/${encodeURIComponent(list.id)}`, { criteriaSet: newSet });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.criteriaSet.criteria).toHaveLength(1);
    // A plain rename needs no config authority — the editor may do it.
    expect((await member.patch(`${L}/${encodeURIComponent(list.id)}`, { name: 'Renamed' })).body.name).toBe('Renamed');
  });
});

describe('priority-matrix — cross-org isolation (project-scoped lists)', () => {
  it('a member with access to org A cannot read or mutate a list in org B (404)', async () => {
    const tenantId = `org:pm-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    // Two orgs in the same tenant/workspace.
    const orgA = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Alpha' })).body.orgId;
    const orgB = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    // The member is an editor in A only.
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    // A list scoped to org B.
    const listB = (await owner.post(L, { orgId: orgB, name: 'B-only', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(listB.id)}`;

    // The member can't even see it (no existence leak) and can't add an idea.
    expect((await member.get(base)).status).toBe(404);
    expect((await member.post(`${base}/ideas`, { title: 'sneak' })).status).toBe(404);
    // It also doesn't show up in their index.
    expect((await member.get(L)).body.lists.map((x: any) => x.id)).not.toContain(listB.id);
    // The owner (tenant owner ⇒ scope in every org) can.
    expect((await owner.get(base)).status).toBe(200);
  });
});

describe('priority-matrix — planning session', () => {
  it('generates an agenda from the top-N ideas (inline markdown when documents is off)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Plan it', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const a = (await owner.post(`${base}/ideas`, { title: 'Top idea' })).body;
    const b = (await owner.post(`${base}/ideas`, { title: 'Lesser idea' })).body;
    await owner.put(`${base}/ideas/${encodeURIComponent(a.id)}/scores`, { scores: HIGH });
    await owner.put(`${base}/ideas/${encodeURIComponent(b.id)}/scores`, { scores: LOW });
    const session = await owner.post(`${base}/sessions`, { name: 'Q3 session', mode: 'top-n', n: 1 });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    expect(session.body.agendaMarkdown).toContain('Top idea');
    expect(session.body.agendaMarkdown).not.toContain('Lesser idea');
    expect(session.body.agendaDocumentId).toBeUndefined(); // documents toggle off ⇒ inline
    const sessions = await owner.get(`${base}/sessions`);
    expect(sessions.body.sessions).toHaveLength(1);
  });

  it('orders the SAVED agenda by the requested sort, not only by priority (ADR 0058)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Order it', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const a = (await owner.post(`${base}/ideas`, { title: 'Top idea' })).body;
    const b = (await owner.post(`${base}/ideas`, { title: 'Lesser idea' })).body;
    await owner.put(`${base}/ideas/${encodeURIComponent(a.id)}/scores`, { scores: HIGH });
    await owner.put(`${base}/ideas/${encodeURIComponent(b.id)}/scores`, { scores: LOW });

    // Default order = priority: the higher-scored "Top idea" comes first.
    const byPriority: string = (await owner.post(`${base}/sessions`, { mode: 'manual', cardIds: [a.id, b.id] })).body.agendaMarkdown;
    expect(byPriority.indexOf('Top idea')).toBeLessThan(byPriority.indexOf('Lesser idea'));

    // sort=title (asc): "Lesser idea" sorts before "Top idea" — the saved doc reorders.
    const byTitle: string = (await owner.post(`${base}/sessions`, { mode: 'manual', cardIds: [a.id, b.id], sort: 'title' })).body.agendaMarkdown;
    expect(byTitle.indexOf('Lesser idea')).toBeLessThan(byTitle.indexOf('Top idea'));
    expect(byTitle).toContain('**Submitted:**'); // the date line that makes a by-date order legible
  });

  it('re-orders an existing agenda IN PLACE (PATCH) without spawning a duplicate session (ADR 0058)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'In place', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const a = (await owner.post(`${base}/ideas`, { title: 'Top idea' })).body;
    const b = (await owner.post(`${base}/ideas`, { title: 'Lesser idea' })).body;
    await owner.put(`${base}/ideas/${encodeURIComponent(a.id)}/scores`, { scores: HIGH });
    await owner.put(`${base}/ideas/${encodeURIComponent(b.id)}/scores`, { scores: LOW });

    const created = (await owner.post(`${base}/sessions`, { mode: 'manual', cardIds: [a.id, b.id] })).body;
    expect((created.agendaMarkdown as string).indexOf('Top idea')).toBeLessThan((created.agendaMarkdown as string).indexOf('Lesser idea'));

    // PATCH re-orders the SAME session by title — same id, reversed order.
    const patched = await owner.patch(`${base}/sessions/${encodeURIComponent(created.id)}`, { sort: 'title' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.id).toBe(created.id);
    expect((patched.body.agendaMarkdown as string).indexOf('Lesser idea')).toBeLessThan((patched.body.agendaMarkdown as string).indexOf('Top idea'));

    // Still ONE session — reorder mutates in place, no proliferation.
    expect((await owner.get(`${base}/sessions`)).body.sessions).toHaveLength(1);
    // A non-existent session id → 404.
    expect((await owner.patch(`${base}/sessions/psession-nope`, { sort: 'title' })).status).toBe(404);
  });

  it('persists the agenda as a board-agenda document when the documents feature is on', async () => {
    const setDocs = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('documents'); if (d) await saveConfig({ ...d, status }, 'test'); };
    await setDocs('on');
    try {
      const { owner, orgId } = await ownerWithOrg();
      const list = (await owner.post(L, { orgId, name: 'Compose', presetId: 'weighted' })).body;
      const base = `${L}/${encodeURIComponent(list.id)}`;
      const a = (await owner.post(`${base}/ideas`, { title: 'Doc-backed idea' })).body;
      await owner.put(`${base}/ideas/${encodeURIComponent(a.id)}/scores`, { scores: HIGH });
      const session = await owner.post(`${base}/sessions`, { mode: 'top-n', n: 1 });
      expect(session.status, JSON.stringify(session.body)).toBe(201);
      // Composed (ADR 0053): the agenda is also persisted as a board-agenda document.
      expect(session.body.agendaDocumentId).toBeTruthy();
    } finally {
      await setDocs('off'); // restore — the inline-fallback test above asserts OFF
    }
  });
});

interface ScheduleIdea { cardId: string; state: string }

describe('priority-matrix — schedule status (ADR 0103)', () => {
  it('derives ahead/behind from target dates + status, and rolls up list health', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Roadmap', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const future = (await owner.post(`${base}/ideas`, { title: 'On track' })).body;
    const past = (await owner.post(`${base}/ideas`, { title: 'Behind' })).body;
    const undated = (await owner.post(`${base}/ideas`, { title: 'No date' })).body;

    // Dates far from "now" so the assertion is clock-independent.
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(future.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(200);
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(past.id)}/schedule`, { targetDate: '2000-01-01' })).status).toBe(200);

    const r = await owner.get(`${base}/schedule`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stateOf = (id: string): string => r.body.ideas.find((i: ScheduleIdea) => i.cardId === id)?.state;
    expect(stateOf(future.id)).toBe('on-track');
    expect(stateOf(past.id)).toBe('behind');
    expect(stateOf(undated.id)).toBe('unscheduled');
    expect(r.body.rollup.behind).toBe(1);
    expect(r.body.rollup.onTrack).toBe(1);
    expect(r.body.rollup.unscheduled).toBe(1);
    expect(r.body.rollup.total).toBe(3);
    expect(r.body.rollup.health).toBe('behind'); // any behind ⇒ behind

    // Completing the behind idea before its (past) target is impossible, but completing
    // the future-dated idea reads done-early.
    expect((await owner.patch(`${base}/ideas/${encodeURIComponent(future.id)}/status`, { columnId: 'done' })).status).toBe(200);
    const r2 = await owner.get(`${base}/schedule`);
    expect(r2.body.ideas.find((i: ScheduleIdea) => i.cardId === future.id)?.state).toBe('done-early');
  });

  it('clears a schedule (revert to unscheduled) and validates the date', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Dates', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Dated' })).body;

    // Bad date → 400.
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: 'not-a-date' })).status).toBe(400);
    // Set then clear.
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(200);
    expect((await owner.del(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`)).status).toBe(204);
    // Clearing again → 404 (nothing set).
    expect((await owner.del(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`)).status).toBe(404);
    const r = await owner.get(`${base}/schedule`);
    expect(r.body.ideas.find((i: ScheduleIdea) => i.cardId === idea.id)?.state).toBe('unscheduled');
  });

  it('gates the schedule write routes: a viewer reads but cannot set/clear (403); the owner can', async () => {
    const tenantId = `org:pm-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const viewer = client();
    const viewerUser = await signup(viewer, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    // Viewer role = workspace:read but NOT workspace:write (accessControl built-in).
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerUser.userId, roles: ['viewer'] });
    const list = (await owner.post(L, { orgId, name: 'Gated', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Item' })).body;

    // Viewer can READ the schedule rollup…
    expect((await viewer.get(`${base}/schedule`)).status).toBe(200);
    // …but cannot SET or CLEAR it (needs workspace:write → 403).
    expect((await viewer.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(403);
    expect((await viewer.del(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`)).status).toBe(403);
    // The owner can.
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(200);

    // Cross-org isolation: a list in another org of the same tenant the viewer has no
    // membership in → a uniform 404 (no existence leak), on both read and write.
    const orgB = (await owner.post('/v1/host/openwop-app/orgs', { name: 'OrgB' })).body.orgId;
    const listB = (await owner.post(L, { orgId: orgB, name: 'B-only', presetId: 'weighted' })).body;
    const baseB = `${L}/${encodeURIComponent(listB.id)}`;
    expect((await viewer.get(`${baseB}/schedule`)).status).toBe(404);
    expect((await viewer.put(`${baseB}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(404);
  });

  it('cascades schedule rows on list delete (no stale state leaks into a new list)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Ephemeral', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Dated' })).body;
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(200);
    // Delete the list (cascades board, scores, schedules, votes, sessions).
    expect((await owner.del(base)).status).toBe(204);
    // The schedule read is now 404 (list gone) — the row did not survive.
    expect((await owner.get(`${base}/schedule`)).status).toBe(404);
  });
});
