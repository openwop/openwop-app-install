/**
 * ADR 0610 D3′ / CPC-15 — a PROJECT-owned document must not be readable by a
 * workspace:read org member who is NOT a project member when the project is
 * `private`. The documents read door (`GET …/documents/:documentId`) gated on
 * `workspace:read` org-scope ONLY, never on project membership — the SAME "two
 * doors, same rows, opposite answers" shape CPC-2 fixed on the KB door. The one
 * `host/subjectAccess.ts` `resolveSubjectAccess` seam is the fix: when the row
 * carries a `kind:'project'` ownerSubject, the read door must consult it.
 *
 * WRITE stays org-scoped (ADR 0054 — membership never grants write), so this
 * pins the READ door only. Positive controls guard against a dead cure (the
 * owner and a project member still read; an `org`-visible project is unaffected).
 *
 * @see docs/adr/0610-owner-subject-access-and-egress-allowlist.md (D3′)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createBoard, createCard } from '../src/host/kanbanService.js';

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
  for (const id of ['users', 'projects', 'documents', 'app-builder', 'priority-matrix', 'work-selection']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const P = '/v1/host/openwop-app/projects';
const DOC = (orgId: string): string => `/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/documents`;
const CANVAS = (orgId: string): string => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}/canvases`;
const ARTIFACT = (artifactId: string): string => `/v1/host/openwop-app/artifacts/${encodeURIComponent(artifactId)}`;
const PM = '/v1/host/openwop-app/priority-matrix';
const RANKING = (boardId: string): string => `/v1/host/openwop-app/work-selection/boards/${encodeURIComponent(boardId)}/ranking`;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

/** Owner + a PRIVATE project + a project-owned document. */
async function privateProjectDoc(visibility: 'private' | 'org' = 'private') {
  const tenantId = `org:adr0610-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('own'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const create = await owner.post(DOC(orgId), {
    title: 'Merger plan', kind: 'note', format: 'markdown',
    ownerSubject: { kind: 'project', id: projectId },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const documentId: string = create.body.documentId;
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility })).body.visibility).toBe(visibility);
  return { tenantId, orgId, projectId, documentId, owner };
}

/** A real org VIEWER (workspace:read) of the same org who is NOT a project member. */
async function orgViewer(tenantId: string, orgId: string): Promise<Client & { userId: string }> {
  const viewer = client();
  const viewerId = (await viewer.post('/v1/host/openwop-app/test/login', { email: uniqEmail('view'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  return Object.assign(viewer, { userId: viewerId as string });
}

describe("ADR 0610 D3' — a private project's document is not readable by a non-member org viewer", () => {
  it('the org viewer is REFUSED at the documents read door (born-red before the fix)', async () => {
    const { tenantId, orgId, documentId, owner, projectId } = await privateProjectDoc('private');
    const viewer = await orgViewer(tenantId, orgId);

    // Control: the project door already refuses the viewer, and the viewer really
    // is an org reader (so a 404 below is the project gate, not a broken login).
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(404);

    // THE LEAK: a workspace:read org non-member reading a private project's doc.
    // Must be 404 (no existence leak), same posture as the KB door (CPC-2).
    const leaked = await viewer.get(`${DOC(orgId)}/${documentId}`);
    expect(leaked.status).toBe(404);
    // Positive control against a dead cure — the title must not appear whatever
    // shape a future refusal takes.
    expect(JSON.stringify(leaked.body ?? {})).not.toContain('Merger plan');

    // Positive control: the OWNER still reads it (not a brick).
    expect((await owner.get(`${DOC(orgId)}/${documentId}`)).status).toBe(200);
  });

  it('a project MEMBER regains the read door; an ORG-visible project is unaffected', async () => {
    const { tenantId, orgId, documentId, owner, projectId } = await privateProjectDoc('private');
    const viewer = await orgViewer(tenantId, orgId);
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewer.userId}`, role: 'observer' })).status).toBe(201);

    // Membership grants READ on a private project — and it must reach the doc door.
    expect((await viewer.get(`${DOC(orgId)}/${documentId}`)).status).toBe(200);

    // And an ORG-visible project's doc is readable by any org viewer (no over-block).
    const open = await privateProjectDoc('org');
    const stranger = await orgViewer(open.tenantId, open.orgId);
    expect((await stranger.get(`${DOC(open.orgId)}/${open.documentId}`)).status).toBe(200);
  });

  // The ARTIFACT lane (host/artifactProjection) is a SECOND door over the same
  // document rows — it must agree with the documents feature's door (CPC-15).
  it('the org viewer is refused at the ARTIFACT lane over the same private-project doc', async () => {
    const { tenantId, orgId, documentId, owner } = await privateProjectDoc('private');
    const viewer = await orgViewer(tenantId, orgId);
    const aid = `document:${documentId}`;
    // Owner control FIRST: the doc DOES project as an artifact (non-vacuous).
    expect((await owner.get(ARTIFACT(aid))).status).toBe(200);
    const leaked = await viewer.get(ARTIFACT(aid));
    expect(leaked.status).toBe(404);
    expect(JSON.stringify(leaked.body ?? {})).not.toContain('Merger plan');
  });

  // The Library LIST is the SECOND half of the artifact door-pair — the single-GET
  // above was gated, but the list must not enumerate the same private-project doc
  // (adversarial-review finding — `listArtifacts` filtered on org scope only).
  it('the Library LIST does not enumerate a private-project doc to a non-member', async () => {
    const { tenantId, orgId, documentId, owner } = await privateProjectDoc('private');
    const viewer = await orgViewer(tenantId, orgId);
    const aid = `document:${documentId}`;
    // Owner control: the doc IS in the owner's Library (non-vacuous).
    const ownerLib = await owner.get('/v1/host/openwop-app/artifacts');
    expect(JSON.stringify(ownerLib.body.artifacts ?? [])).toContain(aid);
    // Non-member: NOT enumerated.
    const viewerLib = await viewer.get('/v1/host/openwop-app/artifacts');
    expect(JSON.stringify(viewerLib.body.artifacts ?? [])).not.toContain(aid);
    expect(JSON.stringify(viewerLib.body.artifacts ?? [])).not.toContain('Merger plan');
  });
});

/** Owner + a PRIVATE project + a project-owned app-builder canvas. */
async function privateProjectCanvas(visibility: 'private' | 'org' = 'private') {
  const tenantId = `org:adr0610c-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('cown'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId: 'canvas.app-builder', name: 'Secret app',
    ownerSubject: { kind: 'project', id: projectId },
    initialState: { name: 'Secret app', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] },
  });
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility })).body.visibility).toBe(visibility);
  return { tenantId, orgId, projectId, canvasId: canvas.canvasId, owner };
}

describe("ADR 0610 D3' — a private project's canvas is not readable by a non-member org viewer", () => {
  it('the org viewer is REFUSED at the canvas read door (single loadCanvas choke)', async () => {
    const { tenantId, orgId, canvasId, owner, projectId } = await privateProjectCanvas('private');
    const viewer = await orgViewer(tenantId, orgId);
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(404); // control

    // THE LEAK: a workspace:read non-member reads a private project's canvas.
    const leaked = await viewer.get(`${CANVAS(orgId)}/${canvasId}`);
    expect(leaked.status).toBe(404);
    expect(JSON.stringify(leaked.body ?? {})).not.toContain('Secret app');
    // The version-history door funnels through the SAME loadCanvas choke.
    expect((await viewer.get(`${CANVAS(orgId)}/${canvasId}/versions`)).status).toBe(404);

    expect((await owner.get(`${CANVAS(orgId)}/${canvasId}`)).status).toBe(200); // owner control
  });

  it('a project MEMBER regains the canvas read door; an ORG-visible project is unaffected', async () => {
    const { tenantId, orgId, canvasId, owner, projectId } = await privateProjectCanvas('private');
    const viewer = await orgViewer(tenantId, orgId);
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewer.userId}`, role: 'observer' })).status).toBe(201);
    expect((await viewer.get(`${CANVAS(orgId)}/${canvasId}`)).status).toBe(200);

    const open = await privateProjectCanvas('org');
    const stranger = await orgViewer(open.tenantId, open.orgId);
    expect((await stranger.get(`${CANVAS(open.orgId)}/${open.canvasId}`)).status).toBe(200);
  });
});

/** Owner + a PRIVATE project + a project-bound priority list (which provisions a
 *  project-owned host.kanban board). */
async function privateProjectList(visibility: 'private' | 'org' = 'private') {
  const tenantId = `org:adr0610p-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pown'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const created = await owner.post(`${PM}/lists`, { orgId, projectId, name: 'Secret backlog' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const listId: string = created.body.id;
  // A project-owned GENERIC kanban board (default To Do column) with a card, for
  // the work-selection ranking door — a priority-matrix board has no 'todo' lane
  // so `readBoardRanking` returns [] for it regardless (a vacuous fixture).
  const board = await createBoard({ tenantId, name: 'Secret board', ownerSubject: { kind: 'project', id: projectId } });
  const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do')!;
  await createCard({ boardId: board.id, columnId: todo.id, title: 'Do the secret thing' });
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility })).body.visibility).toBe(visibility);
  return { tenantId, orgId, projectId, listId, boardId: board.id, owner };
}

describe("ADR 0610 D3' — a private project's priority list + work-selection ranking are not readable by a non-member", () => {
  it('the org viewer is REFUSED at the priority-matrix list door AND the work-selection ranking door', async () => {
    const { tenantId, orgId, listId, boardId, owner, projectId } = await privateProjectList('private');
    const viewer = await orgViewer(tenantId, orgId);
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(404); // control

    // CPC-14: the priority-matrix list read door.
    const leakedList = await viewer.get(`${PM}/lists/${listId}`);
    expect(leakedList.status).toBe(404);
    expect(JSON.stringify(leakedList.body ?? {})).not.toContain('Secret backlog');
    // And the list must not enumerate to the viewer.
    const listing = await viewer.get(`${PM}/lists?orgId=${encodeURIComponent(orgId)}`);
    expect(JSON.stringify(listing.body ?? {})).not.toContain(listId);

    // Positive control FIRST: the OWNER's ranking is NON-EMPTY — so the viewer's
    // empty result below is the gate refusing, not an empty board (non-vacuous).
    const ownerRanking = await owner.get(RANKING(boardId));
    expect(ownerRanking.status).toBe(200);
    expect((ownerRanking.body.ranked as unknown[]).length).toBeGreaterThan(0);

    // WSC-1 (=CPC-14): the work-selection ranking door over the SAME project board.
    // Reports EMPTY (not 404) — the door's fail-closed posture.
    const ranking = await viewer.get(RANKING(boardId));
    expect(ranking.status).toBe(200);
    expect(ranking.body.ranked).toEqual([]);

    // The OWNER still reads the list too.
    expect((await owner.get(`${PM}/lists/${listId}`)).status).toBe(200);
  });

  it('a project MEMBER regains the list door; an ORG-visible project is unaffected', async () => {
    const { tenantId, orgId, listId, owner, projectId } = await privateProjectList('private');
    const viewer = await orgViewer(tenantId, orgId);
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewer.userId}`, role: 'observer' })).status).toBe(201);
    expect((await viewer.get(`${PM}/lists/${listId}`)).status).toBe(200);

    const open = await privateProjectList('org');
    const stranger = await orgViewer(open.tenantId, open.orgId);
    expect((await stranger.get(`${PM}/lists/${open.listId}`)).status).toBe(200);
  });
});
