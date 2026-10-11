/**
 * Projects (ADR 0046 / ADR 0045 Phase 3) — ROUTE harness. Proves a `kind:'project'`
 * Subject owns the unified surfaces:
 *   - create provisions the project's board (generic `ownerSubject`)
 *   - the project's memory rides the `project:<id>` scope (add/list/delete)
 *   - org-scoped RBAC (a viewer can read, not create); always-on (no toggle); tenant IDOR
 *   - delete cascades the board + memory
 *
 * Every refused write is asserted on the stored state as well as its status: a
 * gate that answers 403/404 and writes anyway is the failure these cases exist
 * to catch, and a status-only assertion cannot tell the two apart.
 *
 * Sabotage-witnessed (grade-tests w13), each red on its own probe: the org-scope
 * gate on create; board provisioning + its cascade; the charter enum check; the
 * project read rule (`levelFor`: org-visible read, the member ref shape, the
 * fail-closed tail); knowledge unbind + the bind write gate; both `canWrite`
 * projections; the schedule `enabled` patch + the cross-project job owner check;
 * the kanban board write gate, claim gate and `/assigned` filter; member
 * validation; the group chat's `ownerSubject` + the delete's conversation
 * cascade; the moderator-membership rule + chair clearing; and the CPWF-3 cap
 * (slice, chair-first, churn count, prune arm, grandfathering).
 *
 * HONEST CEILINGS — two DOUBLE guards, where breaking one guard alone stays green:
 *  - cross-tenant IDOR: `getProject`'s tenant check AND `resolveEffectiveAccess`
 *    (a stranger holds no member row in the foreign org ⇒ zero scopes outside
 *    demo mode) each 404 the stranger (probe `rt-getproject-tenant`);
 *  - the schedule cascade on delete: `deleteProject` lists owned jobs, then
 *    re-lists them after the row delete (ADR 0839 D3), so either arm alone clears
 *    the job (probe `rt-sched-cascade-first`; the race is owned by
 *    `adr0839-projects-access-and-writes.test.ts` D3).
 *
 * @see docs/adr/0046-project-subject.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getBoard, createCard, listCardsAssignedToUser } from '../src/host/kanbanService.js';
import { createMember } from '../src/host/accessControlService.js';
import { listJobsForSubject, scheduleSubject } from '../src/host/schedulingService.js';
import { getConversationMeta, ensureConversationMeta, subjectConversationId } from '../src/host/conversationStore.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../src/host/multiPartyConversation.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
/** The response fields this file reads — decoded ONCE at the JSON boundary
 *  (`call<T>`); an un-annotated call's body is `unknown`, never `any`. */
interface LoginBody { user: { userId: string } }
interface OrgBody { orgId: string }
interface CharterBody { goal?: string; objectives?: string[]; status?: string; milestones?: { id: string; title: string; done: boolean }[] }
interface ProjectBody {
  id: string; tenantId: string; orgId: string; name: string; boardId: string; canWrite?: boolean;
  workflows: string[]; visibility?: string; moderatorRosterId?: string; turnPolicy?: unknown; charter?: CharterBody;
}
interface ProjectList { projects: ProjectBody[] }
interface DeleteBody { deleted: boolean; schedulesCleared: number; conversationsDeleted: number }
interface NotesBody { notes: { id: string }[] }
interface KnowledgeBody { collections: { collectionId: string; name: string; documents: unknown[] }[] }
interface CollectionBody { collectionId: string }
interface RetrieveBody { hasResults: boolean; chunks: { kind: string }[] }
interface ScheduleBody { jobId: string; cronExpr: string; enabled: boolean }
interface SchedulesBody { schedules: ScheduleBody[] }
interface CardBody { id: string; assigneeId?: string }
interface BoardBody { board: { id: string; name: string }; cards: CardBody[] }
interface BoardsBody { boards: { id: string }[] }
interface CardsBody { cards: CardBody[] }
interface ClaimBody { card: CardBody }
interface MembersBody { members: { ref: string }[] }
interface ChatOpenBody { sessionId: string }
interface MessagesBody { messages: { content: string }[] }
interface RosterBody { rosterId: string }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = unknown>(p: string) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const decoded: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: decoded as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pj') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

const P = '/host/openwop-app/projects';

describe('projects — always-on (graduated off its toggle)', () => {
  it('serves a signed-in scoped caller with no toggle; an unscoped caller gets nothing', async () => {
    const { c, orgId } = await ownerWithOrg();
    // No `projects` toggle is enabled anywhere — the surface is always-on.
    expect((await c.post<ProjectBody>(P, { orgId, name: 'Always' })).status).toBe(201);
    // An anon/unscoped caller (tenant `default`, no org scope): empty list (no
    // leak), and a write is forbidden — access stays org-scoped without the toggle.
    const anon = client();
    expect((await anon.get<ProjectList>(P)).body.projects).toEqual([]);
    expect((await anon.post<ProjectBody>(P, { orgId, name: 'Nope' })).status).toBe(403);
  });
});

describe('projects — create provisions a board + owns memory', () => {
  it('create → board exists; memory add/list/delete; update workflows; delete cascades', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post<ProjectBody>(P, { orgId, name: 'Launch Q3' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    const boardId = created.body.boardId;
    expect(boardId).toBeTruthy();
    // The project's board was provisioned with a {kind:'project'} owner.
    expect((await getBoard(boardId))?.ownerSubject).toEqual({ kind: 'project', id });

    // Project memory (the project:<id> subject scope).
    const add = await c.post<NotesBody>(`${P}/${id}/memory`, { content: 'Launch gating criteria: security sign-off.' });
    expect(add.status).toBe(201);
    expect(add.body.notes.length).toBe(1);
    const noteId = add.body.notes[0].id;
    expect((await c.get<NotesBody>(`${P}/${id}/memory`)).body.notes.length).toBe(1);
    expect((await c.del(`${P}/${id}/memory/${noteId}`)).status).toBe(204);

    // Assigned workflows (entity-local).
    const upd = await c.patch<ProjectBody>(`${P}/${id}`, { workflows: ['wf:weekly-report'] });
    expect(upd.body.workflows).toEqual(['wf:weekly-report']);

    // Delete cascades the board + memory.
    expect((await c.del<DeleteBody>(`${P}/${id}`)).body.deleted).toBe(true);
    expect(await getBoard(boardId)).toBeNull();
    expect((await c.get<ProjectBody>(`${P}/${id}`)).status).toBe(404);
  });

  it('charter (ADR 0054 D1): set → validate/cap → read back → clear', async () => {
    const { c, orgId } = await ownerWithOrg();
    const id = (await c.post<ProjectBody>(P, { orgId, name: 'Chartered' })).body.id;

    // Set a charter — valid fields kept, unknown status dropped, milestone id minted.
    const set = await c.patch<ProjectBody>(`${P}/${id}`, {
      charter: {
        goal: 'Ship v1', objectives: ['scope', 'build', ''], brief: 'The brief.',
        startDate: '2026-07-01', endDate: '2026-09-30', status: 'active', health: 'on-track',
        milestones: [{ title: 'Alpha', dueDate: '2026-08-01' }, { title: '' }],
        bogus: 'nope',
      },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const ch: CharterBody = set.body.charter ?? {};
    expect(ch.goal).toBe('Ship v1');
    expect(ch.objectives).toEqual(['scope', 'build']); // empty dropped
    expect(ch.status).toBe('active');
    expect(ch.milestones?.length).toBe(1);             // empty-title milestone dropped
    const [milestone] = ch.milestones ?? [];
    expect(milestone?.id).toBeTruthy();                // id minted
    expect(milestone?.done).toBe(false);
    // The unknown field was sent INSIDE the charter, so that is where it must be
    // absent. (This used to read `set.body.bogus` — a top-level key nobody sent,
    // which could never be defined.)
    expect(Object.keys(ch)).not.toContain('bogus');

    // A bad enum is dropped (not a 400 — forgiving), the rest persists.
    const upd = await c.patch<ProjectBody>(`${P}/${id}`, { charter: { goal: 'Still', status: 'invalid' } });
    expect(upd.body.charter?.goal).toBe('Still');
    expect(upd.body.charter?.status).toBeUndefined();
    // …and the stored row agrees with the response.
    expect((await c.get<ProjectBody>(`${P}/${id}`)).body.charter).toEqual({ goal: 'Still' });

    // Clear with null.
    expect((await c.patch<ProjectBody>(`${P}/${id}`, { charter: null })).body.charter).toBeUndefined();
  });
});

describe('projects — RBAC + isolation', () => {
  it('a different tenant cannot see or mutate a project (IDOR 404)', async () => {
    const a = await ownerWithOrg();
    const created = await a.c.post<ProjectBody>(P, { orgId: a.orgId, name: 'A-proj' });
    const id = created.body.id;
    const stranger = await ownerWithOrg();
    expect((await stranger.c.get<ProjectBody>(`${P}/${id}`)).status).toBe(404);
    expect((await stranger.c.del<DeleteBody>(`${P}/${id}`)).status).toBe(404);
    // The refused delete took nothing: the owner still reads the project.
    const still = await a.c.get<ProjectBody>(`${P}/${id}`);
    expect(still.status).toBe(200);
    expect(still.body.name).toBe('A-proj');
  });

  it('a co-tenant member with NO scope in the project\'s org cannot list or read it (no existence leak)', async () => {
    // Owner creates a project in their org.
    const tenantId = `org:pjx-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pj-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Owned' })).body.orgId;
    const created = await owner.post<ProjectBody>(P, { orgId, name: 'Private proj' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;

    // A co-tenant member with NO org membership (no workspace:read anywhere).
    const member = client();
    await member.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pj-member'), tenantId });

    // The list excludes it (org-scoped); GET → uniform 404 (no existence leak).
    expect((await member.get<ProjectList>(P)).body.projects).toEqual([]);
    expect((await member.get<ProjectBody>(`${P}/${id}`)).status).toBe(404);
    expect((await member.del<DeleteBody>(`${P}/${id}`)).status).toBe(404);

    // The owner still sees it.
    expect((await owner.get<ProjectList>(P)).body.projects.length).toBe(1);
  });
});

const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';

describe('projects — knowledge (cited documents, generic subject binding)', () => {
  it('creates+binds a collection, ingests a doc, retrieve composes docs + project memory', async () => {
    const { c, orgId } = await ownerWithOrg();
    const id = (await c.post<ProjectBody>(P, { orgId, name: 'KB proj' })).body.id;

    const col = await c.post<CollectionBody>(`${P}/${id}/knowledge/collections`, { orgId, name: 'Project handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = col.body.collectionId;
    expect((await c.post(`${P}/${id}/knowledge/collections/${cid}/documents`, { orgId, title: 'Cats', text: FELINE })).status).toBe(201);

    // The view lists the bound collection + its doc.
    const view = await c.get<KnowledgeBody>(`${P}/${id}/knowledge`);
    expect(view.body.collections.length).toBe(1);
    expect(view.body.collections[0].documents.length).toBe(1);

    // A project memory note too — retrieve composes BOTH (one corpus).
    await c.post<NotesBody>(`${P}/${id}/memory`, { content: 'Project rule: cite the handbook.' });
    const ret = await c.post<RetrieveBody>(`${P}/${id}/knowledge/retrieve`, { query: 'how do cats groom and purr' });
    expect(ret.body.hasResults).toBe(true);
    const kinds = (ret.body.chunks as Array<{ kind: string }>).map((x) => x.kind);
    expect(kinds).toContain('kb');
    expect(kinds).toContain('memory');

    // Unbind drops it from the view (the KB collection survives).
    expect((await c.del(`${P}/${id}/knowledge/bindings/${cid}`)).status).toBe(204);
    expect((await c.get<KnowledgeBody>(`${P}/${id}/knowledge`)).body.collections.length).toBe(0);
    expect((await c.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}`)).status).toBe(200);
  });

  it('a project VIEWER (workspace:read, no write) can READ knowledge but cannot bind/create-bind (mutation needs project write)', async () => {
    // Owner creates the project + a collection in the project's org.
    const tenantId = `org:pjv-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjv-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'ViewerCo' })).body.orgId;
    const id = (await owner.post<ProjectBody>(P, { orgId, name: 'Guarded proj' })).body.id;
    const cid = (await owner.post<CollectionBody>(`${P}/${id}/knowledge/collections`, { orgId, name: 'Handbook' })).body.collectionId;

    // A second user in the SAME tenant, added to the org as a read-only `viewer`.
    // Membership matches on the resolved `User.userId` (what the routes use as the
    // acting subject), so seed the member with the id the login returns.
    const viewer = client();
    const vlogin = await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjv-viewer'), tenantId });
    const viewerSubject = vlogin.body.user.userId;
    const add = await owner.post(`/host/openwop-app/orgs/${orgId}/members`, { displayName: 'Viewer', subject: viewerSubject, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    // READ is allowed (workspace:read) ...
    expect((await viewer.get<KnowledgeBody>(`${P}/${id}/knowledge`)).status).toBe(200);
    expect((await viewer.post<RetrieveBody>(`${P}/${id}/knowledge/retrieve`, { query: 'anything' })).status).toBe(200);
    // ... but mutating the project's binding set is forbidden (403) — the viewer
    // must not be able to change what the project's agents/workflows retrieve.
    expect((await viewer.post(`${P}/${id}/knowledge/bindings`, { collectionId: cid })).status).toBe(403);
    expect((await viewer.post<CollectionBody>(`${P}/${id}/knowledge/collections`, { orgId, name: 'Sneaky' })).status).toBe(403);
    expect((await viewer.del(`${P}/${id}/knowledge/bindings/${cid}`)).status).toBe(403);
    // None of the three refused writes landed: the binding set is exactly the
    // owner's one collection — no 'Sneaky' created+bound, the handbook not unbound.
    expect((await owner.get<KnowledgeBody>(`${P}/${id}/knowledge`)).body.collections.map((col) => col.name)).toEqual(['Handbook']);
  });
});

describe('projects — write-capability projection (ADR 0063)', () => {
  it('GET / list / create carry the caller\'s canWrite (org-writer true, viewer false), matching the gate', async () => {
    const tenantId = `org:pjw-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjw-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'WriteCo' })).body.orgId;

    // The creator is an org writer → canWrite on the create response, GET, and list.
    const created = await owner.post<ProjectBody>(P, { orgId, name: 'Gated proj' });
    expect(created.body.canWrite).toBe(true);
    const id = created.body.id;
    expect((await owner.get<ProjectBody>(`${P}/${id}`)).body.canWrite).toBe(true);
    expect((await owner.get<ProjectList>(P)).body.projects.find((p: { id: string }) => p.id === id)?.canWrite).toBe(true);

    // A read-only org viewer can READ the project, but canWrite is false …
    const viewer = client();
    const vlogin = await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjw-viewer'), tenantId });
    await owner.post(`/host/openwop-app/orgs/${orgId}/members`, { displayName: 'V', subject: vlogin.body.user.userId, roles: ['viewer'] });
    const vget = await viewer.get<ProjectBody>(`${P}/${id}`);
    expect(vget.status).toBe(200);
    expect(vget.body.canWrite).toBe(false);
    expect((await viewer.get<ProjectList>(P)).body.projects.find((p: { id: string }) => p.id === id)?.canWrite).toBe(false);

    // … and the projection matches the authority: the viewer's actual write 403s.
    expect((await viewer.patch<ProjectBody>(`${P}/${id}`, { name: 'Renamed' })).status).toBe(403);
    expect((await owner.get<ProjectBody>(`${P}/${id}`)).body.name, 'the refused write must not land').toBe('Gated proj');
  });
});

describe('projects — schedules (the ONE scheduler, generic project owner)', () => {
  it('create → owned by project:<id> on the real scheduler; list/patch/delete; cascade', async () => {
    const { c, orgId } = await ownerWithOrg();
    const proj = (await c.post<ProjectBody>(P, { orgId, name: 'Cadence proj' })).body;
    const id = proj.id;
    const tenantId = proj.tenantId; // the owner's (personal) tenant — owns the job too

    const created = await c.post<ScheduleBody>(`${P}/${id}/schedules`, { cronExpr: '0 9 * * 1', workflowId: 'wf:weekly-report', timezone: 'UTC' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body.jobId;
    expect(created.body.cronExpr).toBe('0 9 * * 1');
    expect(created.body.enabled).toBe(true);

    // It rides the ONE scheduler, owned by the project subject (no parallel store).
    const owned = await listJobsForSubject(tenantId, { kind: 'project', id });
    expect(owned.map((j) => j.jobId)).toContain(jobId);
    expect(scheduleSubject(owned[0]!)).toEqual({ kind: 'project', id });

    // List via the project surface.
    expect((await c.get<SchedulesBody>(`${P}/${id}/schedules`)).body.schedules.length).toBe(1);

    // Patch (disable + re-cadence).
    const patched = await c.patch<ScheduleBody>(`${P}/${id}/schedules/${jobId}`, { enabled: false, cronExpr: '0 8 * * *' });
    expect(patched.body.enabled).toBe(false);
    expect(patched.body.cronExpr).toBe('0 8 * * *');

    // Delete one.
    expect((await c.del(`${P}/${id}/schedules/${jobId}`)).status).toBe(204);
    expect((await c.get<SchedulesBody>(`${P}/${id}/schedules`)).body.schedules.length).toBe(0);

    // Re-create, then delete the project → cascade clears the schedule off the scheduler.
    await c.post<ScheduleBody>(`${P}/${id}/schedules`, { cronExpr: '*/5 * * * *' });
    const del = await c.del<DeleteBody>(`${P}/${id}`);
    expect(del.body.schedulesCleared).toBe(1);
    expect((await listJobsForSubject(tenantId, { kind: 'project', id })).length).toBe(0);
  });

  it('cross-project / cross-tenant IDOR: a stranger cannot patch or delete the schedule (404)', async () => {
    const a = await ownerWithOrg();
    const id = (await a.c.post<ProjectBody>(P, { orgId: a.orgId, name: 'A-sched' })).body.id;
    const jobId = (await a.c.post<ScheduleBody>(`${P}/${id}/schedules`, { cronExpr: '0 0 * * *' })).body.jobId;

    // A different project in the SAME owner/tenant can't reach A's job (wrong owner).
    const other = (await a.c.post<ProjectBody>(P, { orgId: a.orgId, name: 'B-sched' })).body.id;
    expect((await a.c.patch(`${P}/${other}/schedules/${jobId}`, { enabled: false })).status).toBe(404);
    expect((await a.c.del(`${P}/${other}/schedules/${jobId}`)).status).toBe(404);

    // A foreign tenant can't reach the project at all (project IDOR → 404).
    const stranger = await ownerWithOrg();
    expect((await stranger.c.get<SchedulesBody>(`${P}/${id}/schedules`)).status).toBe(404);
    expect((await stranger.c.del(`${P}/${id}/schedules/${jobId}`)).status).toBe(404);

    // Every refused patch/delete left the job exactly as it was: still listed
    // under its own project, still enabled.
    const own = (await a.c.get<SchedulesBody>(`${P}/${id}/schedules`)).body.schedules;
    expect(own.map((s) => s.jobId)).toEqual([jobId]);
    expect(own[0]?.enabled).toBe(true);
  });
});

const K = '/host/openwop-app/kanban';
const B = '/host/openwop-app/kanban/boards';

describe('projects — board read-privacy (org-scoped board visibility, ADR 0046)', () => {
  it('a co-tenant non-member cannot see or list the project board (404 / dropped); the owner can', async () => {
    const tenantId = `org:pjb-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjb-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'BoardCo' })).body.orgId;
    const boardId = (await owner.post<ProjectBody>(P, { orgId, name: 'Board proj' })).body.boardId;
    expect(boardId).toBeTruthy();

    // The org owner reaches the board.
    expect((await owner.get<BoardBody>(`${B}/${boardId}`)).status).toBe(200);

    // A co-tenant member with NO org membership: 404 on the board (no card leak),
    // and it does NOT appear in their board list (was tenant-visible before ADR 0046).
    const member = client();
    await member.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjb-member'), tenantId });
    expect((await member.get<BoardBody>(`${B}/${boardId}`)).status).toBe(404);
    expect((await member.get<BoardsBody>(B)).body.boards.some((b: { id: string }) => b.id === boardId)).toBe(false);
    expect((await member.get<BoardsBody>(`${B}?include=cards`)).body.boards.some((b: { id: string }) => b.id === boardId)).toBe(false);
  });

  it('a project VIEWER reads the board but cannot mutate it (write needs org write)', async () => {
    const tenantId = `org:pjb2-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjb2-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'BoardCo2' })).body.orgId;
    const boardId = (await owner.post<ProjectBody>(P, { orgId, name: 'Board proj 2' })).body.boardId;

    const viewer = client();
    const vlogin = await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjb2-viewer'), tenantId });
    await owner.post(`/host/openwop-app/orgs/${orgId}/members`, { displayName: 'V', subject: vlogin.body.user.userId, roles: ['viewer'] });

    // READ (workspace:read): the viewer sees the board + it lists.
    expect((await viewer.get<BoardBody>(`${B}/${boardId}`)).status).toBe(200);
    expect((await viewer.get<BoardsBody>(B)).body.boards.some((b: { id: string }) => b.id === boardId)).toBe(true);
    // WRITE (needs workspace:write): create card / rename / delete are all 404 for a viewer.
    expect((await viewer.post<CardBody>(`${B}/${boardId}/cards`, { columnId: 'todo', title: 'x' })).status).toBe(404);
    expect((await viewer.patch(`${B}/${boardId}`, { name: 'Renamed' })).status).toBe(404);
    expect((await viewer.del(`${B}/${boardId}`)).status).toBe(404);
    // None of the refused writes landed: the board keeps its name and has no cards.
    const before = await owner.get<BoardBody>(`${B}/${boardId}`);
    expect(before.status).toBe(200);
    expect(before.body.board.name).not.toBe('Renamed');
    expect(before.body.cards).toEqual([]);
    // The owner CAN write, and the write lands.
    expect((await owner.patch(`${B}/${boardId}`, { name: 'Owner rename' })).status).toBe(200);
    expect((await owner.get<BoardBody>(`${B}/${boardId}`)).body.board.name).toBe('Owner rename');
  });

  it('a co-tenant non-member cannot CLAIM a role-addressed card on a project board (org write required)', async () => {
    const tenantId = `org:pjc-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjc-owner'), tenantId })).body.user.userId;
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'ClaimCo' })).body.orgId;
    const boardId = (await owner.post<ProjectBody>(P, { orgId, name: 'Claim proj' })).body.boardId;

    // Owner adds a card and role-addresses it (unclaimed: assigneeRole set, no assigneeId).
    const cardId = (await owner.post<CardBody>(`${B}/${boardId}/cards`, { title: 'Pick me' })).body.id;
    expect((await owner.post(`${K}/cards/${cardId}/assign`, { assigneeRole: 'editor' })).status).toBe(200);

    // A co-tenant member with NO org membership can't claim it (was tenant-gated → leak).
    const member = client();
    await member.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pjc-member'), tenantId });
    expect((await member.post(`${K}/cards/${cardId}/claim`, {})).status).toBe(404);
    // The refused claim assigned nobody.
    const card = (await owner.get<BoardBody>(`${B}/${boardId}`)).body.cards.find((x) => x.id === cardId);
    expect(card, 'the card is still on the board').toBeDefined();
    expect(card?.assigneeId).toBeUndefined();
    // The org owner still can — and becomes the assignee.
    const claimed = await owner.post<ClaimBody>(`${K}/cards/${cardId}/claim`, {});
    expect(claimed.status).toBe(200);
    expect(claimed.body.card.assigneeId).toBe(ownerId);
  });

  it('a ROLE-addressed card on a project board is filtered from a non-org-member\'s /assigned inbox; a DIRECT assignee is kept', async () => {
    const tenantId = `org:pja-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pja-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'InboxCo' })).body.orgId;
    const boardId = (await owner.post<ProjectBody>(P, { orgId, name: 'Inbox proj' })).body.boardId;
    const firstCol = (await getBoard(boardId))!.columns[0]!.id;

    // A co-tenant member holding the WORKSPACE `editor` role (org id === tenantId,
    // ADR 0015) but NOT a member of the project's org `orgId`. Seed at the service
    // level (the HTTP assign route validates workspace membership; we're testing
    // the /assigned route's org filter, not assignment).
    const member = client();
    const memberSubject = (await member.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pja-member'), tenantId })).body.user.userId;
    await createMember({ tenantId, orgId: tenantId, subject: memberSubject, displayName: 'M', roles: ['editor'] });

    // A role-addressed card (to `editor`) AND a card directly assigned to the member.
    const roleCard = await createCard({ boardId, columnId: firstCol, title: 'Role work', assigneeRole: 'editor' });
    const directCard = await createCard({ boardId, columnId: firstCol, title: 'Direct work', assigneeId: memberSubject });

    // The service DOES return both (proves the filter — not a role mismatch — is what hides it).
    const raw = (await listCardsAssignedToUser(tenantId, memberSubject, ['editor'])).map((c) => c.id);
    expect(raw).toContain(roleCard.id);
    expect(raw).toContain(directCard.id);

    // The ROUTE filters the role-addressed card (member lacks org read) but keeps the direct assignee (D4).
    const ids = ((await member.get<CardsBody>(`${K}/assigned`)).body.cards as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(roleCard.id);
    expect(ids).toContain(directCard.id);
  });
});

describe('projects — membership + visibility (ADR 0054 Phase 2)', () => {
  it('add/list/remove members: a stranger and an unknown agent are rejected', async () => {
    const tenantId = `org:pcm-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcm-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'CollabCo' })).body.orgId;
    const id = (await owner.post<ProjectBody>(P, { orgId, name: 'Crew' })).body.id;

    // A teammate who IS an org member can be added; a stranger (no membership) can't.
    const mate = client();
    const mateId = (await mate.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcm-mate'), tenantId })).body.user.userId;
    await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['editor'] });
    const add = await owner.post<MembersBody>(`${P}/${id}/members`, { ref: `user:${mateId}`, role: 'contributor' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.members.some((m: { ref: string }) => m.ref === `user:${mateId}`)).toBe(true);
    expect((await owner.post<MembersBody>(`${P}/${id}/members`, { ref: 'user:nobody', role: 'lead' })).status).toBe(400);
    expect((await owner.post<MembersBody>(`${P}/${id}/members`, { ref: 'agent:host:does-not-exist', role: 'lead' })).status).toBe(400);

    // List + remove.
    expect((await owner.get<MembersBody>(`${P}/${id}/members`)).body.members.length).toBe(1);
    expect((await owner.del(`${P}/${id}/members/${encodeURIComponent(`user:${mateId}`)}`)).status).toBe(204);
    expect((await owner.get<MembersBody>(`${P}/${id}/members`)).body.members.length).toBe(0);
  });

  it('a PRIVATE project is read-gated to members + org writers across ALL surfaces (board/memory/knowledge/schedules)', async () => {
    const tenantId = `org:pcv-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcv-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
    const proj = (await owner.post<ProjectBody>(P, { orgId, name: 'Secret' })).body;
    const id = proj.id; const boardId = proj.boardId;

    // A co-tenant org VIEWER (workspace:read), NOT a project member.
    const viewer = client();
    const viewerId = (await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcv-viewer'), tenantId })).body.user.userId;
    await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });

    // While `org`-visible the viewer sees it.
    expect((await viewer.get<ProjectBody>(`${P}/${id}`)).status).toBe(200);

    // Make it private.
    expect((await owner.patch<ProjectBody>(`${P}/${id}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');

    // The non-member viewer is now 404 on the project AND every owned surface, and it's dropped from the list.
    expect((await viewer.get<ProjectBody>(`${P}/${id}`)).status).toBe(404);
    expect((await viewer.get<BoardBody>(`${B}/${boardId}`)).status).toBe(404);
    expect((await viewer.get<NotesBody>(`${P}/${id}/memory`)).status).toBe(404);
    expect((await viewer.get<KnowledgeBody>(`${P}/${id}/knowledge`)).status).toBe(404);
    expect((await viewer.get<SchedulesBody>(`${P}/${id}/schedules`)).status).toBe(404);
    expect((await viewer.get<ProjectList>(P)).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
    expect((await viewer.get<BoardsBody>(B)).body.boards.some((b: { id: string }) => b.id === boardId)).toBe(false);

    // The owner (org WRITER) still sees + acts on it (write never needs membership).
    expect((await owner.get<ProjectBody>(`${P}/${id}`)).status).toBe(200);
    expect((await owner.get<BoardBody>(`${B}/${boardId}`)).status).toBe(200);

    // Add the viewer as a member → they regain READ across all surfaces (but not write).
    expect((await owner.post<MembersBody>(`${P}/${id}/members`, { ref: `user:${viewerId}`, role: 'observer' })).status).toBe(201);
    expect((await viewer.get<ProjectBody>(`${P}/${id}`)).status).toBe(200);
    expect((await viewer.get<BoardBody>(`${B}/${boardId}`)).status).toBe(200);
    expect((await viewer.get<KnowledgeBody>(`${P}/${id}/knowledge`)).status).toBe(200);
    expect((await viewer.get<ProjectList>(P)).body.projects.some((p: { id: string }) => p.id === id)).toBe(true);
    // Still no write (membership never grants authority).
    expect((await viewer.patch<ProjectBody>(`${P}/${id}`, { name: 'Renamed' })).status).toBe(403);
    expect((await owner.get<ProjectBody>(`${P}/${id}`)).body.name, 'the refused write must not land').toBe('Secret');
  });
});

describe('projects — group chat (ADR 0054 Phase 3)', () => {
  it('ensures ONE group conversation bound to project:<id> (idempotent), gated by project read', async () => {
    const { c, orgId } = await ownerWithOrg();
    const proj = (await c.post<ProjectBody>(P, { orgId, name: 'War room' })).body;
    const id = proj.id; const tenantId = proj.tenantId;

    const r1 = await c.post<ChatOpenBody>(`${P}/${id}/chat`);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const sessionId = r1.body.sessionId;
    expect(sessionId).toBeTruthy();

    // Idempotent — re-opening returns the SAME conversation (one chat per project).
    expect((await c.post<ChatOpenBody>(`${P}/${id}/chat`)).body.sessionId).toBe(sessionId);

    // Bound to the project subject as a group conversation (ADR 0043 substrate).
    const meta = await getConversationMeta(tenantId, sessionId);
    expect(meta?.type).toBe('group');
    expect(meta?.ownerSubject).toEqual({ kind: 'project', id });

    // A foreign tenant can't open it (project IDOR → 404, via requireProject).
    const stranger = await ownerWithOrg();
    expect((await stranger.c.post<ChatOpenBody>(`${P}/${id}/chat`)).status).toBe(404);
  });

  it('the chat history is gated by project MEMBERSHIP, not participant identity (closes the cross-surface read leak)', async () => {
    const CHAT = '/host/openwop-app/chat/sessions';
    const tenantId = `org:pcc-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcc-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'WarCo' })).body.orgId;
    const id = (await owner.post<ProjectBody>(P, { orgId, name: 'War room' })).body.id;
    const { sessionId } = (await owner.post<ChatOpenBody>(`${P}/${id}/chat`)).body;

    // A co-tenant org VIEWER (workspace:read), NOT the chat's owner/participant.
    const viewer = client();
    const viewerId = (await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcc-viewer'), tenantId })).body.user.userId;
    await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });

    // While `org`-visible the viewer reads the thread through the GENERIC chat route —
    // membership-scoped, NOT the participant heuristic (which would have 404'd a
    // non-owner non-participant). This is what makes the shared room actually shared.
    expect((await viewer.get(`${CHAT}/${sessionId}/messages`)).status).toBe(200);

    // Make it private → the non-member viewer is now 404 on the chat data path too
    // (the leak: before, the chat session bypassed the member-scope gate).
    await owner.patch<ProjectBody>(`${P}/${id}/visibility`, { visibility: 'private' });
    expect((await viewer.get(`${CHAT}/${sessionId}`)).status).toBe(404);
    expect((await viewer.get(`${CHAT}/${sessionId}/messages`)).status).toBe(404);
    expect((await viewer.post(`${CHAT}/${sessionId}/messages`, { messageId: `m-${n++}`, role: 'user', content: 'leak?' })).status).toBe(404);

    // The owner (org WRITER) still reads it — and the refused post did not land.
    const ownerRead = await owner.get<MessagesBody>(`${CHAT}/${sessionId}/messages`);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.messages.map((m) => m.content)).not.toContain('leak?');

    // Add the viewer as a member → they regain READ, but a read-only member may NOT
    // MANAGE the room (delete) — manage requires org write, never mere membership.
    await owner.post<MembersBody>(`${P}/${id}/members`, { ref: `user:${viewerId}`, role: 'observer' });
    expect((await viewer.get(`${CHAT}/${sessionId}/messages`)).status).toBe(200);
    expect((await viewer.del(`${CHAT}/${sessionId}`)).status).toBe(403);
    // The refused delete left the room standing.
    expect((await owner.get(`${CHAT}/${sessionId}`)).status).toBe(200);
  });

  it('deleting the project destroys the chat — it does not merely UNLOCK it (PRJ2-M1)', async () => {
    const CHAT = '/host/openwop-app/chat/sessions';
    const tenantId = `org:pcx-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcx-owner'), tenantId });
    const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'WarCo' })).body.orgId;
    const id = (await owner.post<ProjectBody>(P, { orgId, name: 'Private room' })).body.id;
    const { sessionId } = (await owner.post<ChatOpenBody>(`${P}/${id}/chat`)).body;
    await owner.post(`${CHAT}/${sessionId}/messages`, { messageId: `m-${n++}`, role: 'user', content: 'confidential' });
    await owner.patch<ProjectBody>(`${P}/${id}/visibility`, { visibility: 'private' });

    // A co-tenant stranger: denied BEFORE the delete. This is the control that
    // makes the assertion after the delete mean something.
    const stranger = client();
    await stranger.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcx-stranger'), tenantId });
    expect((await stranger.get(`${CHAT}/${sessionId}/messages`)).status).toBe(404);

    const del = await owner.del<DeleteBody>(`${P}/${id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.conversationsDeleted).toBe(1);

    // THE DEFECT THIS PINS. The first version of PRJ2-M1 cascaded only
    // `deleteConversationMeta` — the one piece the service layer could reach.
    // But the meta is what makes an owned conversation private
    // (`conversationVisibility`: no meta ⇒ "legacy / unowned — tenant-visible"),
    // so the session and its messages survived with the lock removed and this
    // stranger got a 200 on a private project's history. Measured, not
    // theorised. Deleting nothing would have been safer than deleting the meta.
    expect((await stranger.get(`${CHAT}/${sessionId}/messages`)).status).toBe(404);
    expect((await owner.get(`${CHAT}/${sessionId}`)).status).toBe(404);
    expect((await owner.get(`${CHAT}/${sessionId}/messages`)).status).toBe(404);
  });
});

describe('projects — chat cadence (ADR 0054 Phase 4 / D6)', () => {
  it('turnPolicy validates/clamps; moderator MUST be a project agent member; remove clears the chair', async () => {
    const { c, orgId } = await ownerWithOrg();
    const id = (await c.post<ProjectBody>(P, { orgId, name: 'Cadence' })).body.id;

    // A roster agent added as a project AGENT member.
    const rosterId = (await c.post<RosterBody>('/host/openwop-app/roster', { persona: 'Scout', agentRef: { agentId: 'core.openwop.agents.brief-writer' } })).body.rosterId;
    expect((await c.post<MembersBody>(`${P}/${id}/members`, { ref: `agent:${rosterId}`, role: 'contributor' })).status).toBe(201);

    // turnPolicy rides the SHARED validator — rounds clamp to [1,3], order/synthesize default.
    const tp = (await c.patch<ProjectBody>(`${P}/${id}`, { turnPolicy: { rounds: 9, order: 'round-robin' } })).body;
    expect(tp.turnPolicy).toEqual({ rounds: 3, order: 'round-robin', synthesize: true });

    // A valid in-tenant roster agent that is NOT a project member can't be the moderator (422, D6 §3).
    const outsider = (await c.post<RosterBody>('/host/openwop-app/roster', { persona: 'Outsider', agentRef: { agentId: 'core.openwop.agents.brief-writer' } })).body.rosterId;
    expect((await c.patch<ProjectBody>(`${P}/${id}`, { moderatorRosterId: outsider })).status).toBe(422);
    // An unknown roster id → 404.
    expect((await c.patch<ProjectBody>(`${P}/${id}`, { moderatorRosterId: 'host:does-not-exist' })).status).toBe(404);
    // Neither refusal seated a chair.
    expect((await c.get<ProjectBody>(`${P}/${id}`)).body.moderatorRosterId).toBeUndefined();
    // The member agent CAN be the moderator.
    expect((await c.patch<ProjectBody>(`${P}/${id}`, { moderatorRosterId: rosterId })).body.moderatorRosterId).toBe(rosterId);

    // Removing the moderator member clears the now-stale chair (D6 invariant: moderator ∈ members).
    expect((await c.del(`${P}/${id}/members/${encodeURIComponent(`agent:${rosterId}`)}`)).status).toBe(204);
    expect((await c.get<ProjectBody>(`${P}/${id}`)).body.moderatorRosterId).toBeUndefined();

    // `null` clears the policy.
    expect((await c.patch<ProjectBody>(`${P}/${id}`, { turnPolicy: null })).body.turnPolicy).toBeUndefined();

    // Write-gated: a co-tenant viewer (no write) can't set the cadence.
    const viewer = client();
    const vId = (await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail('pcad-viewer'), tenantId: (await c.get<ProjectBody>(`${P}/${id}`)).body.tenantId })).body.user.userId;
    await createMember({ tenantId: (await c.get<ProjectBody>(`${P}/${id}`)).body.tenantId, orgId, subject: vId, displayName: 'V', roles: ['viewer'] });
    expect((await viewer.patch<ProjectBody>(`${P}/${id}`, { turnPolicy: { rounds: 2 } })).status).toBe(403);
    expect((await c.get<ProjectBody>(`${P}/${id}`)).body.turnPolicy, 'the refused write must not land').toBeUndefined();
  });
});

describe('projects — group chat seats cap at the advertised multi-party ceiling (CPWF-3)', () => {
  // Seed N distinct roster agents and add each as a project agent member, in order.
  // `COLWF-1` — the SEATED ref is now the agent's chat-callable projection
  // (`agent:<agentRef.agentId>`), not the member ref (`agent:<rosterId>`), so the RFC 0101
  // speaker rule can match the id that actually answers. These legs assert the SEAT, so they
  // track the seat ref.
  //
  // The fixture now gives each member a DISTINCT `agentRef.agentId`. It previously gave all of
  // them `core.openwop.agents.brief-writer`, which was fine while seats were per-roster-member
  // and is not fine now: two members sharing one registry agent legitimately collapse to ONE
  // seat (the speaker rule cannot tell them apart either way), so nine identical agents would
  // have made a cap-of-eight test assert against one seat. Distinct agents is also the
  // production shape for distinct project members.
  async function seatAgents(c: Client, id: string, count: number): Promise<{ ref: string; rosterId: string; seatRef: string }[]> {
    const out: { ref: string; rosterId: string; seatRef: string }[] = [];
    for (let i = 1; i <= count; i++) {
      const persona = `Cap Agent ${Date.now()}-${n++}`;
      const agentId = `core.openwop.agents.cap-${Date.now()}-${n++}`;
      const rosterId = (await c.post<RosterBody>('/host/openwop-app/roster', { persona, agentRef: { agentId } })).body.rosterId;
      const ref = `agent:${rosterId}`;
      expect((await c.post<MembersBody>(`${P}/${id}/members`, { ref, role: 'contributor' })).status).toBe(201);
      out.push({ ref, rosterId, seatRef: `agent:${agentId}` });
    }
    return out;
  }

  it('a NEW room with more agent members than the cap seats exactly the cap, moderator-first', async () => {
    const { c, orgId } = await ownerWithOrg();
    const proj = (await c.post<ProjectBody>(P, { orgId, name: 'Overfull room' })).body;
    const id = proj.id; const tenantId = proj.tenantId;

    // One over the cap: 9 agent members for a cap of 8.
    const refs = await seatAgents(c, id, MAX_MULTI_PARTY_PARTICIPANTS + 1);
    // Make the LAST-declared agent the moderator so moderator-first is observable:
    // absent chair-priority it would be the one dropped (last in declared order).
    const chair = refs[refs.length - 1]!;
    const chairRosterId = chair.rosterId;
    expect((await c.patch<ProjectBody>(`${P}/${id}`, { moderatorRosterId: chairRosterId })).body.moderatorRosterId).toBe(chairRosterId);

    const r = await c.post<ChatOpenBody>(`${P}/${id}/chat`);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const meta = await getConversationMeta(tenantId, r.body.sessionId);
    const seated = (meta?.participants ?? []).map((pp) => pp.subjectRef).filter((s) => s.startsWith('agent:'));
    // Born-red: before the cap the reconcile seated ALL 9 agent members, exceeding the
    // advertised `multiPartyConversation.maxParticipants`. Now it seats exactly the cap.
    expect(seated.length).toBe(MAX_MULTI_PARTY_PARTICIPANTS);
    // The chair is seated (moderator-first), and one non-chair overflow agent is NOT.
    expect(seated).toContain(chair.seatRef);
    expect(refs.filter((x) => !seated.includes(x.seatRef)).length).toBe(1);
  });

  it('a GRANDFATHERED room already over the cap is neither trimmed nor rejected (no silent unseat)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const proj = (await c.post<ProjectBody>(P, { orgId, name: 'Legacy overfull' })).body;
    const id = proj.id; const tenantId = proj.tenantId;
    const refs = await seatAgents(c, id, MAX_MULTI_PARTY_PARTICIPANTS + 1);

    // Pre-seed the conversation meta OVER the cap, as a room opened before the cap
    // existed would look. `ensureConversationMeta` is create-or-return, so this stands
    // in for the historical state the reconcile must NOT break.
    const sessionId = subjectConversationId(tenantId, projectSubject(id));
    await ensureConversationMeta(tenantId, sessionId, { type: 'group', ownerSubject: projectSubject(id), participants: refs.map((x) => x.seatRef) });

    const r = await c.post<ChatOpenBody>(`${P}/${id}/chat`);
    expect(r.status, JSON.stringify(r.body)).toBe(201); // never a 4xx on a grandfathered room
    const meta = await getConversationMeta(tenantId, r.body.sessionId);
    const seated = (meta?.participants ?? []).map((pp) => pp.subjectRef).filter((s) => s.startsWith('agent:'));
    // All members still members ⇒ zero pruned; already at/over cap ⇒ zero added.
    expect(seated.length).toBe(refs.length);
  });

  it('a member swapped in at the cap is seated in ONE reconcile (churn does not under-seat)', async () => {
    // Finding-1 regression guard: a room at exactly the cap, then one member removed
    // and one added in the same window. The ADD loop runs before the PRUNE loop, so
    // counting the soon-pruned agent toward the cap would block the new member for the
    // whole session. The seat count must stay at the cap after a SINGLE re-open.
    const { c, orgId } = await ownerWithOrg();
    const proj = (await c.post<ProjectBody>(P, { orgId, name: 'Churn room' })).body;
    const id = proj.id; const tenantId = proj.tenantId;
    const refs = await seatAgents(c, id, MAX_MULTI_PARTY_PARTICIPANTS); // exactly the cap
    expect((await c.post<ChatOpenBody>(`${P}/${id}/chat`)).status).toBe(201); // seats all cap agents

    // Swap: remove one seated member, add a fresh one — membership still == cap.
    expect((await c.del(`${P}/${id}/members/${encodeURIComponent(refs[0]!.ref)}`)).status).toBe(204);
    const added = (await seatAgents(c, id, 1))[0]!;

    const r = await c.post<ChatOpenBody>(`${P}/${id}/chat`);
    expect(r.status).toBe(201);
    const meta = await getConversationMeta(tenantId, r.body.sessionId);
    const seated = (meta?.participants ?? []).map((pp) => pp.subjectRef).filter((s) => s.startsWith('agent:'));
    expect(seated.length).toBe(MAX_MULTI_PARTY_PARTICIPANTS); // not cap-1
    expect(seated).toContain(added.seatRef);      // the swapped-in member IS seated
    expect(seated).not.toContain(refs[0]!.seatRef); // the swapped-out member is gone
  });

  it('the prune arm still unseats a REMOVED member even under the cap', async () => {
    const { c, orgId } = await ownerWithOrg();
    const proj = (await c.post<ProjectBody>(P, { orgId, name: 'Small room' })).body;
    const id = proj.id; const tenantId = proj.tenantId;
    const refs = await seatAgents(c, id, 3); // well under the cap

    // Open the room (seats all three), then remove one member and re-open.
    expect((await c.post<ChatOpenBody>(`${P}/${id}/chat`)).status).toBe(201);
    expect((await c.del(`${P}/${id}/members/${encodeURIComponent(refs[0]!.ref)}`)).status).toBe(204);
    const r = await c.post<ChatOpenBody>(`${P}/${id}/chat`);
    expect(r.status).toBe(201);

    const meta = await getConversationMeta(tenantId, r.body.sessionId);
    const seated = (meta?.participants ?? []).map((pp) => pp.subjectRef).filter((s) => s.startsWith('agent:'));
    expect(seated.length).toBe(2);
    expect(seated).not.toContain(refs[0]!.seatRef); // the removed member was unseated
  });
});
