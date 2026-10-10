/**
 * ADR 0842 — Priority Matrix: the run lane asks who started the run, vote
 * secrecy holds on the score trail, and a project's agenda stays the project's.
 *
 * Every leg here was born RED on origin/main `c790b4127`:
 *  - D1 the workflow surface (`ctx.features['priority-matrix']`) was tenant-trusted
 *    for a HUMAN-started run, so an org-A editor's run read and wrote an org-B list
 *    the route, the agent tool and the KB all refuse them;
 *  - D2 `GET …/score-history` (workspace:read) returned every voter's id and
 *    per-criterion scores, while `GET …/votes` refuses anyone but the list
 *    creator or an org admin;
 *  - D3 the planning-agenda Document of a project-bound list carried no
 *    `ownerSubject`, so a private project's top ideas read to every org viewer
 *    and outlived the project.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createList, submitIdea, setIdeaScore, createPlanningSession } from '../src/features/priority-matrix/priorityMatrixService.js';
import { buildPriorityMatrixSurface } from '../src/features/priority-matrix/surface.js';
import { createProject, setProjectVisibility } from '../src/features/projects/projectsService.js';
import { getDocument, canReadDocument } from '../src/features/documents/documentsService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { PM_SUBMIT_IDEA_TOOL_ID } from '../src/features/priority-matrix/agentTools.js';
import { registerSubjectAccessResolver, type SubjectAccessResolver } from '../src/host/subjectAccess.js';
import { listIdeaScoreHistory } from '../src/features/priority-matrix/scoreHistory.js';
import { getIdeaIntake, upsertIdeaIntake, addIdeaEvidence, listIdeaEvidence, markPromoted } from '../src/features/priority-matrix/intake.js';
import { deleteCard } from '../src/host/kanbanService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;
let n = 0;

const toggle = async (id: string): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await toggle('priority-matrix');
  await toggle('documents');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `pm842-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/host/openwop-app/priority-matrix/lists';
const A = { 'strategic-alignment': 9, roi: 9, urgency: 9, 'compliance-risk': 9, cost: 1 };
const B = { 'strategic-alignment': 3, roi: 3, urgency: 3, 'compliance-risk': 3, cost: 7 };

describe('ADR 0842 D2 — the score-change trail keeps multi-voter ballots secret', () => {
  it('a reader sees the aggregate trail and their own vote — never another voter’s id or scores', async () => {
    const tenantId = `org:pm842-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, tenantId);
    const voter = client(); const voterUser = await signup(voter, tenantId);
    const reader = client(); const readerUser = await signup(reader, tenantId);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: voterUser.userId, roles: ['editor'] });
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'R', subject: readerUser.userId, roles: ['editor'] });

    const list = (await owner.post(L, { orgId, name: 'Council', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'mean' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Shared idea' })).body;
    const ideaBase = `${base}/ideas/${encodeURIComponent(idea.id)}`;
    expect((await voter.put(`${ideaBase}/scores`, { scores: A })).status).toBe(200);
    expect((await reader.put(`${ideaBase}/scores`, { scores: B })).status).toBe(200);
    // The trail is appended fire-and-forget; wait until both rows are durable.
    for (let i = 0; i < 50 && (await listIdeaScoreHistory(tenantId, list.id, idea.id)).length < 2; i++) await new Promise((r) => setTimeout(r, 10));

    // Control: the per-voter breakdown is refused to a non-config member.
    expect((await reader.get(`${ideaBase}/votes`)).status).toBe(403);

    const r = await reader.get(`${ideaBase}/score-history`);
    expect(r.status).toBe(200);
    const history = r.body.history as Array<Record<string, unknown>>;
    expect(history.length).toBe(2);
    const raw = JSON.stringify(history);
    expect(raw).not.toContain(voterUser.userId);
    // The aggregate trail survives: every row keeps its priority movement.
    for (const h of history) expect(typeof h.newPriority).toBe('number');
    // The reader's OWN row keeps its scores; the other voter's row carries none.
    const mine = history.filter((h) => h.voterId === readerUser.userId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.scores).toEqual(B);
    const theirs = history.filter((h) => h.voterId !== readerUser.userId);
    expect(theirs.length).toBe(1);
    expect(theirs[0]!.scores).toBeUndefined();
    expect(theirs[0]!.actor).toBeUndefined();

    // The list creator holds config authority and still sees the full trail.
    const full = await owner.get(`${ideaBase}/score-history`);
    expect(JSON.stringify(full.body.history)).toContain(voterUser.userId);
  });
});

describe('ADR 0842 D9 — list reads project what the caller may do', () => {
  it('owner: write + configure; editor: write only; viewer: neither — the same predicates the doors use', async () => {
    const tenantId = `org:pm842v-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, tenantId);
    const editor = client(); const editorUser = await signup(editor, tenantId);
    const viewerC = client(); const viewerUser = await signup(viewerC, tenantId);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorUser.userId, roles: ['editor'] });
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerUser.userId, roles: ['viewer'] });
    const list = (await owner.post(L, { orgId, name: 'Perms', presetId: 'weighted' })).body;
    const one = async (c: Client) => (await c.get(`${L}/${encodeURIComponent(list.id)}`)).body.viewer;
    expect(await one(owner)).toEqual({ canWrite: true, canConfigure: true });
    expect(await one(editor)).toEqual({ canWrite: true, canConfigure: false });
    expect(await one(viewerC)).toEqual({ canWrite: false, canConfigure: false });
    // The index carries the same projection.
    const idx = (await viewerC.get(L)).body.lists as Array<{ id: string; viewer: unknown }>;
    expect(idx.find((l) => l.id === list.id)?.viewer).toEqual({ canWrite: false, canConfigure: false });
    // And the projection is not authority: the viewer's write is still refused at the door.
    expect((await viewerC.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'x' })).status).toBe(403);
  });
});

describe('ADR 0842 D1 — the run lane gates a human-started run like the HTTP door', () => {
  const T = `pm842-run-${Date.now()}`;
  let orgA: string; let orgB: string; let listB: { id: string }; let ideaB: { id: string };
  beforeAll(async () => {
    orgA = (await createOrg({ tenantId: T, createdBy: 'own', name: 'A', ownerSubject: 'own' })).orgId;
    orgB = (await createOrg({ tenantId: T, createdBy: 'own', name: 'B', ownerSubject: 'own' })).orgId;
    await createMember({ orgId: orgA, tenantId: T, displayName: 'Ed', subject: 'ed-a', roles: ['editor'] });
    listB = await createList(T, orgB, 'own', { name: 'Org B secret roadmap zebra' });
    ideaB = await submitIdea(T, listB.id, 'own', { title: 'B-only idea quokka' });
    await createList(T, orgA, 'own', { name: 'Org A roadmap' });
  });

  it('reads: an org-A editor’s run does not see org-B lists or ideas', async () => {
    const s = buildPriorityMatrixSurface({ tenantId: T, actingUserId: 'ed-a' });
    const lists = JSON.stringify(await s.listLists!({}));
    expect(lists).toContain('Org A roadmap');
    expect(lists).not.toContain('zebra');
    // An unreadable list answers exactly as a missing id does — no existence oracle.
    await expect(s.listRankedIdeas!({ listId: listB.id })).rejects.toThrow(/not found/i);
    await expect(s.listRankedIdeas!({ listId: 'plist-does-not-exist' })).rejects.toThrow(/not found/i);
    expect(JSON.stringify(await s.listPortfolio!({}))).not.toContain('quokka');
    await expect(s.getScheduleStatus!({ listId: listB.id })).rejects.toThrow(/not found/i);
    expect(await s.getIntake!({ listId: listB.id, cardId: ideaB.id })).toEqual({ intake: null, evidence: [] });
  });

  it('a reader without write is refused writes with forbidden_scope (the route\'s 403)', async () => {
    await createMember({ orgId: orgB, tenantId: T, displayName: 'Vi', subject: 'vi-b', roles: ['viewer'] });
    const s = buildPriorityMatrixSurface({ tenantId: T, actingUserId: 'vi-b' });
    expect(JSON.stringify(await s.listRankedIdeas!({ listId: listB.id }))).toContain('quokka');
    await expect(s.scoreIdea!({ listId: listB.id, cardId: ideaB.id, scores: { 'strategic-alignment': 9 } })).rejects.toThrow(/workspace:write/);
  });

  it('RATCHET — every surface verb is classified, so a new verb cannot skip the gate', () => {
    const verbs = Object.keys(buildPriorityMatrixSurface({ tenantId: T, actingUserId: 'ed-a' })).sort();
    const GATED_READ = ['getIntake', 'getScheduleStatus', 'listLists', 'listPortfolio', 'listRankedIdeas'];
    const GATED_WRITE = ['addEvidence', 'generateAgenda', 'proposeScenario', 'scoreIdea', 'submitIdea', 'updateIntake'];
    expect(verbs).toEqual([...GATED_READ, ...GATED_WRITE].sort());
  });

  it('writes: an org-A editor’s run cannot score, file, annotate or plan on an org-B list', async () => {
    const s = buildPriorityMatrixSurface({ tenantId: T, actingUserId: 'ed-a' });
    await expect(s.scoreIdea!({ listId: listB.id, cardId: ideaB.id, scores: { 'strategic-alignment': 9 } })).rejects.toThrow(/not found/i);
    await expect(s.submitIdea!({ listId: listB.id, title: 'planted' })).rejects.toThrow(/not found/i);
    // These three verbs answer a MISSING list with a null shape, so an unreadable one
    // answers exactly the same (no existence oracle) — and writes nothing.
    expect(await s.updateIntake!({ listId: listB.id, cardId: ideaB.id, patch: { notes: 'x' } })).toEqual({ intake: null });
    expect(await s.addEvidence!({ listId: listB.id, cardId: ideaB.id, kind: 'url', ref: 'https://x.test' })).toEqual({ evidence: null });
    expect(await s.proposeScenario!({ listId: listB.id, sessionId: 'psession-x', name: 'n', selection: { mode: 'top-n', n: 1 } })).toEqual({ scenario: null });
    expect(await s.updateIntake!({ listId: 'plist-missing', cardId: ideaB.id, patch: { notes: 'x' } })).toEqual({ intake: null });
    expect(await getIdeaIntake(listB.id, ideaB.id)).toBeNull();
    expect(await listIdeaEvidence(listB.id, ideaB.id)).toEqual([]);
    await expect(s.generateAgenda!({ listId: listB.id, n: 1 })).rejects.toThrow(/not found/i);
  });

  it('a SYSTEM run (no acting user) stays tenant-trusted — the forms-intake bridge keeps filing', async () => {
    const s = buildPriorityMatrixSurface({ tenantId: T });
    expect(JSON.stringify(await s.listLists!({}))).toContain('zebra');
    const filed = await s.submitIdea!({ listId: listB.id, title: 'From a form', orgId: orgB });
    expect(typeof (filed as { cardId: string }).cardId).toBe('string');
  });
});

describe('ADR 0842 D3 — a project-bound list’s agenda Document belongs to the project', () => {
  it('owned by the project, so a non-member org viewer cannot read it', async () => {
    const T = `pm842-doc-${Date.now()}`;
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    await createMember({ orgId, tenantId: T, displayName: 'V', subject: 'viewer-1', roles: ['viewer'] });
    const project = await createProject(T, orgId, { name: 'Secret' }, 'own');
    await setProjectVisibility(T, project.id, 'private');
    const list = await createList(T, orgId, 'own', { name: 'Secret list', projectId: project.id });
    const idea = await submitIdea(T, list.id, 'own', { title: 'Acquire competitor walrus' });
    await setIdeaScore(T, list.id, idea.id, 'own', { 'strategic-alignment': 9 });
    const session = await createPlanningSession(T, list.id, 'own', { mode: 'top-n', n: 1 });
    expect(session.agendaDocumentId).toBeDefined();
    const doc = await getDocument(T, orgId, session.agendaDocumentId!);
    expect(doc?.ownerSubject).toEqual({ kind: 'project', id: project.id });
    expect(await canReadDocument(T, doc!, 'viewer-1')).toBe(false);
    expect(await canReadDocument(T, doc!, 'own')).toBe(true);
  });
});

describe('ADR 0842 D4 — the agent write tools ask the project, as the route does', () => {
  it('a write tool refuses a project-bound list the seam answers `none` for', async () => {
    const T = `pm842-tool-${Date.now()}`;
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    const project = await createProject(T, orgId, { name: 'P' }, 'own');
    const list = await createList(T, orgId, 'own', { name: 'P list', projectId: project.id });
    // A project the seam cannot place (dangling, or a future resolver rule) — the route
    // 404s on exactly this answer; the tool must not write through it.
    const restore = await swapProjectResolver(async () => 'none');
    try {
      const out = await createAgentToolProvider({ tenantId: T, actingUserId: 'own' }).executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'through the side door' } });
      expect(out.isError).toBe(true);
      expect(out.content).toMatch(/not_found|not found/i);
    } finally { await restore(); }
  });
});

describe('ADR 0842 D8 — a comment thread on a private project\'s idea asks the project', () => {
  it('a non-member org viewer cannot open the thread; a member can', async () => {
    const T = `pm842-cmt-${Date.now()}`;
    await toggle('comments');
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    await createMember({ orgId, tenantId: T, displayName: 'V', subject: 'viewer-2', roles: ['viewer'] });
    const project = await createProject(T, orgId, { name: 'Secret' }, 'own');
    await setProjectVisibility(T, project.id, 'private');
    const list = await createList(T, orgId, 'own', { name: 'Secret list', projectId: project.id });
    const idea = await submitIdea(T, list.id, 'own', { title: 'Hidden idea narwhal' });
    const { createComment } = await import('../src/features/comments/commentsService.js');
    const post = (subject: string) => createComment({ tenantId: T, orgId, resourceType: 'priority_idea', resourceId: `${list.id}#${idea.id}`, body: 'hi', authorId: subject, caller: { subject } });
    await expect(post('viewer-2')).rejects.toThrow(/not found/i);
    await expect(post('own')).resolves.toBeDefined();
  });
});

describe('ADR 0842 D10 — a strategy link to a private project\'s idea asks the project', () => {
  it('a non-member org viewer cannot resolve it; a member can; an actorless lane keeps the org answer', async () => {
    const T = `pm842-strat-${Date.now()}`;
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    await createMember({ orgId, tenantId: T, displayName: 'V', subject: 'viewer-3', roles: ['viewer'] });
    const project = await createProject(T, orgId, { name: 'Secret' }, 'own');
    await setProjectVisibility(T, project.id, 'private');
    const list = await createList(T, orgId, 'own', { name: 'Secret list' });
    const bound = await createList(T, orgId, 'own', { name: 'Bound list', projectId: project.id });
    const { resolvePriorityLinkTarget } = await import('../src/features/strategy/strategyService.js');
    const { getList } = await import('../src/features/priority-matrix/priorityMatrixService.js');
    const load = (id: string) => getList(T, id);
    const orgRead = async () => true; // the viewer DOES read the org
    expect((await resolvePriorityLinkTarget(bound.id, load, orgRead, { tenantId: T, callerSubject: 'viewer-3' })).readable).toBe(false);
    expect((await resolvePriorityLinkTarget(bound.id, load, orgRead, { tenantId: T, callerSubject: 'own' })).readable).toBe(true);
    expect((await resolvePriorityLinkTarget(list.id, load, orgRead, { tenantId: T, callerSubject: 'viewer-3' })).readable).toBe(true);
    expect((await resolvePriorityLinkTarget(bound.id, load, orgRead, { tenantId: T, callerSubject: undefined })).readable).toBe(true);
  });
});

describe('ADR 0842 D7 — the planning-session cap is enforced', () => {
  it('refuses the session past the cap before doing any work', async () => {
    const T = `pm842-cap-${Date.now()}`;
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    const list = await createList(T, orgId, 'own', { name: 'Cap' });
    await submitIdea(T, list.id, 'own', { title: 'One' });
    for (let i = 0; i < 200; i++) await createPlanningSession(T, list.id, 'own', { mode: 'top-n', n: 1, name: `s${i}` });
    await expect(createPlanningSession(T, list.id, 'own', { mode: 'top-n', n: 1 })).rejects.toThrow(/maximum 200 planning sessions/);
  }, 60_000);
});

describe('ADR 0842 D5 — an idea delete takes its intake, evidence and score trail', () => {
  it('kanban-side and PM-side deletes leave no per-card overlay behind', async () => {
    const T = `pm842-cascade-${Date.now()}`;
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    const list = await createList(T, orgId, 'own', { name: 'L' });
    const idea = await submitIdea(T, list.id, 'own', { title: 'Doomed' });
    await setIdeaScore(T, list.id, idea.id, 'own', { 'strategic-alignment': 5 });
    await upsertIdeaIntake({ tenantId: T, orgId, listId: list.id, cardId: idea.id, actor: 'own', patch: { requester: 'jane@acme.test' } });
    await addIdeaEvidence({ tenantId: T, orgId, listId: list.id, cardId: idea.id, actor: 'own', kind: 'url', ref: 'https://e.test', label: 'e' });
    for (let i = 0; i < 50 && (await listIdeaScoreHistory(T, list.id, idea.id)).length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await deleteCard(idea.id); // the kanban door
    expect(await getIdeaIntake(list.id, idea.id)).toBeNull();
    expect(await listIdeaEvidence(list.id, idea.id)).toEqual([]);
    expect(await listIdeaScoreHistory(T, list.id, idea.id)).toEqual([]);

    // The PM door (`deleteIdea`) — same overlays, same outcome.
    const second = await submitIdea(T, list.id, 'own', { title: 'Doomed too' });
    await setIdeaScore(T, list.id, second.id, 'own', { 'strategic-alignment': 5 });
    await upsertIdeaIntake({ tenantId: T, orgId, listId: list.id, cardId: second.id, actor: 'own', patch: { requester: 'joe@acme.test' } });
    for (let i = 0; i < 50 && (await listIdeaScoreHistory(T, list.id, second.id)).length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    const { deleteIdea } = await import('../src/features/priority-matrix/priorityMatrixService.js');
    expect(await deleteIdea(T, list.id, second.id, 'own')).toBe(true);
    expect(await getIdeaIntake(list.id, second.id)).toBeNull();
    expect(await listIdeaScoreHistory(T, list.id, second.id)).toEqual([]);
  });
});

describe('PM4CD-1 — an intake patch racing a promote never erases the promotion', () => {
  it('a promote that lands between the patch\'s read and its write survives', async () => {
    const T = `pm842-race-${Date.now()}`;
    const orgId = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Acme', ownerSubject: 'own' })).orgId;
    const list = await createList(T, orgId, 'own', { name: 'Race' });
    const idea = await submitIdea(T, list.id, 'own', { title: 'Raced' });
    await upsertIdeaIntake({ tenantId: T, orgId, listId: list.id, cardId: idea.id, actor: 'own', patch: { notes: 'seed' } });
    // Deterministic interleaving: the patch's FIRST read of the intake row lets a promote
    // complete before the read returns, so the patch then writes from a stale row.
    const key = `${list.id}::${idea.id}`;
    const realGet = DurableCollection.prototype.get;
    let injected = false;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      const row = await realGet.call(this, id);
      if (!injected && id === key) {
        injected = true;
        await markPromoted({ tenantId: T, orgId, listId: list.id, cardId: idea.id, actor: 'own', promotedTo: { kind: 'project', id: 'p-raced' } });
      }
      return row;
    });
    try {
      await upsertIdeaIntake({ tenantId: T, orgId, listId: list.id, cardId: idea.id, actor: 'own', patch: { notes: 'patched' } });
    } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    const row = await getIdeaIntake(list.id, idea.id);
    expect(row?.promotedTo).toEqual({ kind: 'project', id: 'p-raced' });
    expect(row?.notes).toBe('patched');
  });
});

/** Swap the `project` subject-access resolver for one test, restoring the real one. */
async function swapProjectResolver(fn: SubjectAccessResolver): Promise<() => Promise<void>> {
  const { resolveProjectAccess } = await import('../src/features/projects/projectsService.js');
  registerSubjectAccessResolver('project', fn);
  return async () => {
    registerSubjectAccessResolver('project', async (tenantId, subject, caller) => resolveProjectAccess(tenantId, subject.id, caller));
  };
}
