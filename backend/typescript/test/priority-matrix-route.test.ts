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
 *
 * Sabotage-witnessed (grade-tests w15): removing the lists-route toggle gate, the
 * config-authority branch, the org-scope check or the write-scope check in
 * `loadListScoped`; the bogus-project 404; the rank sort; the status move; the
 * top-N slice; the agenda sort; the documents compose branch (both ways) and
 * the agenda content written to it; skipping the session CAS write; the
 * schedule-row cascade in `deleteList`; the terminal-lane classification; and
 * the clear-schedule 404 — each turns a case below red.
 * Ceiling: "without firing a workflow" is not witnessable here — a PM board
 * column binds no workflow and `moveIdeaStatus` discards kanban's trigger.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { __pmStoresForErasure } from '../src/features/priority-matrix/priorityMatrixService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('pm'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = (status: 'on' | 'off'): Promise<void> => enableToggle('priority-matrix', status);

async function ownerWithOrg(): Promise<{ owner: Client; userId: string; orgId: string }> {
  const owner = client();
  const u = await signup(owner);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, userId: u.userId, orgId: org.body.orgId };
}

const L = '/host/openwop-app/priority-matrix/lists';
// Default "weighted" preset criterion ids (ADR 0058 CRITERIA_PRESETS.weighted).
const HIGH = { 'strategic-alignment': 10, roi: 10, urgency: 10, 'compliance-risk': 10, cost: 1 };
const LOW = { 'strategic-alignment': 1, roi: 1, urgency: 1, 'compliance-risk': 1, cost: 10 };

describe('priority-matrix — toggle gating', () => {
  it('404s when the toggle is off', async () => {
    await enable('off');
    try {
      const c = client();
      await signup(c);
      expect((await c.get(L)).status).toBe(404);
    } finally {
      await enable('on'); // never leak a disabled toggle into a later (shuffled) case
    }
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
    const proj = await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch Q3' });
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

  it('moves an idea through statuses and the new column persists', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Flow', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Move me' })).body;
    const moved = await owner.patch(`${base}/ideas/${encodeURIComponent(idea.id)}/status`, { columnId: 'in-process' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.columnId).toBe('in-process');
    // Persisted, not just echoed: the ranked read sees the idea in its new column.
    const ideas = (await owner.get(`${base}/ideas`)).body.ideas as Array<{ card: { id: string }; status: { columnId: string } }>;
    expect(ideas.find((i) => i.card.id === idea.id)?.status.columnId).toBe('in-process');
  });
});

describe('priority-matrix — config authority', () => {
  it('a co-tenant editor cannot change criteria/weights; the owner can', async () => {
    const tenantId = `org:pm-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'Guarded', presetId: 'weighted' })).body;

    const newSet = { aggregation: 'weighted-sum', criteria: [{ name: 'Only one', weight: 9, direction: 'benefit' }] };
    // Editor may read but not rewrite the scoring model.
    expect((await member.patch(`${L}/${encodeURIComponent(list.id)}`, { criteriaSet: newSet })).status).toBe(403);
    // …and the refused write did not land: the preset's five criteria are intact.
    expect((await owner.get(`${L}/${encodeURIComponent(list.id)}`)).body.criteriaSet.criteria).toHaveLength(5);
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
    const orgA = (await owner.post('/host/openwop-app/orgs', { name: 'Alpha' })).body.orgId;
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    // The member is an editor in A only.
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    // A list scoped to org B.
    const listB = (await owner.post(L, { orgId: orgB, name: 'B-only', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(listB.id)}`;

    // The member can't even see it (no existence leak) and can't add an idea.
    expect((await member.get(base)).status).toBe(404);
    expect((await member.post(`${base}/ideas`, { title: 'sneak' })).status).toBe(404);
    expect((await owner.get(`${base}/ideas`)).body.ideas, 'the refused idea was not created').toHaveLength(0);
    // It also doesn't show up in their index.
    expect((await member.get(L)).body.lists.map((x: { id: string }) => x.id)).not.toContain(listB.id);
    // The owner (tenant owner ⇒ scope in every org) can.
    expect((await owner.get(base)).status).toBe(200);
  });
});

describe('priority-matrix — planning session', () => {
  it('generates an agenda from the top-N ideas (inline markdown when documents is off)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    // documents defaults ON (2026-07-09) — set off explicitly for the inline path.
    await enableToggle('documents', 'off');
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

    // Still ONE session — reorder mutates in place, no proliferation — and the STORED
    // row carries the new order (not just the PATCH response).
    const stored = (await owner.get(`${base}/sessions`)).body.sessions as Array<{ id: string; agendaMarkdown: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(created.id);
    expect(stored[0].agendaMarkdown.indexOf('Lesser idea')).toBeLessThan(stored[0].agendaMarkdown.indexOf('Top idea'));
    // A non-existent session id → 404.
    expect((await owner.patch(`${base}/sessions/psession-nope`, { sort: 'title' })).status).toBe(404);
  });

  it('persists the agenda as a board-agenda document when the documents feature is on', async () => {
    const setDocs = (status: 'on' | 'off'): Promise<void> => enableToggle('documents', status);
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
      // …and the document really holds the agenda.
      const doc = await owner.get(`/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/documents/${encodeURIComponent(session.body.agendaDocumentId)}`);
      expect(doc.status, JSON.stringify(doc.body)).toBe(200);
      expect(doc.body.kind).toBe('board-agenda');
      expect(doc.body.currentVersion?.content).toContain('Doc-backed idea');
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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    // Viewer role = workspace:read but NOT workspace:write (accessControl built-in).
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerUser.userId, roles: ['viewer'] });
    const list = (await owner.post(L, { orgId, name: 'Gated', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Item' })).body;

    // Viewer can READ the schedule rollup…
    expect((await viewer.get(`${base}/schedule`)).status).toBe(200);
    // …but cannot SET or CLEAR it (needs workspace:write → 403).
    expect((await viewer.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(403);
    expect((await viewer.del(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`)).status).toBe(403);
    // The refused PUT did not land.
    const afterViewer = await owner.get(`${base}/schedule`);
    expect(afterViewer.body.ideas.find((i: ScheduleIdea) => i.cardId === idea.id)?.state).toBe('unscheduled');
    // The owner can.
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(200);

    // Cross-org isolation: a list in another org of the same tenant the viewer has no
    // membership in → a uniform 404 (no existence leak), on both read and write.
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'OrgB' })).body.orgId;
    const listB = (await owner.post(L, { orgId: orgB, name: 'B-only', presetId: 'weighted' })).body;
    const baseB = `${L}/${encodeURIComponent(listB.id)}`;
    // An idea that really lives in list B — otherwise the PUT 404s on "idea not in this
    // list" whatever the org gate does.
    const ideaB = (await owner.post(`${baseB}/ideas`, { title: 'B item' })).body;
    expect(ideaB.id).toBeTruthy();
    expect((await viewer.get(`${baseB}/schedule`)).status).toBe(404);
    expect((await viewer.put(`${baseB}/ideas/${encodeURIComponent(ideaB.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(404);
  });

  it('cascades schedule rows on list delete (no stale state leaks into a new list)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Ephemeral', presetId: 'weighted' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Dated' })).body;
    expect((await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/schedule`, { targetDate: '2999-01-01' })).status).toBe(200);
    const { schedules } = __pmStoresForErasure();
    const rowsFor = async (): Promise<number> => (await schedules.list()).filter((r) => r.listId === list.id).length;
    expect(await rowsFor(), 'the schedule row exists before the delete').toBe(1);
    // Delete the list (cascades board, scores, schedules, votes, sessions).
    expect((await owner.del(base)).status).toBe(204);
    expect((await owner.get(`${base}/schedule`)).status).toBe(404);
    // The 404 above is the deleted LIST; the cascade claim is the STORED row.
    expect(await rowsFor(), 'the schedule row did not survive the list delete').toBe(0);
  });
});
