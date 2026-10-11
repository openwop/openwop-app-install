/**
 * ADR 0839 D2 (`PRJ3WF-2`) — deleting a project takes the rows OTHER features own under it.
 *
 * BORN RED on `origin/main` @ `557f95faa`: `DELETE /projects/:id` left a project-owned canvas,
 * a project-scoped priority list (and its own board), the team ledger with its deltas, and a
 * project-owned document. Each one's door asks the project for access, so after the delete
 * they were refused to everyone — the canvas could not even be deleted — and only tenant
 * teardown removed them.
 *
 * ROUTE level, through `createApp`, because the registrations live in four different
 * features' `registerRoutes`; a service test would have to re-register them by hand and so
 * could not see a feature that forgot to.
 *
 * Witnessed (w13): renaming a registration key, or making any one feature's purge skip its
 * delete, reds the cascade leg; widening the preview's scope to read reds the viewer leg.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { getBoard } from '../src/host/kanbanService.js';
import { listSubjectDependentKeys } from '../src/host/subjectDependents.js';
import { createList, getList } from '../src/features/priority-matrix/priorityMatrixService.js';
import { createLedger, getLedger, listDeltas } from '../src/features/team-intent-ledger/ledgerStore.js';
import { createDocument, getDocumentByIdForTenant } from '../src/features/documents/documentsService.js';
import { getProject } from '../src/features/projects/projectsService.js';
import { createMember } from '../src/host/accessControlService.js';

let BASE = '';
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Typed per call site: `T` names the body shape the leg reads; no `any`. */
interface Res<T> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}
type Counts = Record<string, number>;

const P = '/host/openwop-app/projects';

async function projectWithDependents() {
  const c = client();
  expect((await c.post('/host/openwop-app/test/login', { email: `dep-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
  const orgId = (await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const created = await c.post<{ id: string; tenantId: string }>(P, { orgId, name: 'Has dependents' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = (await getProject(created.body.tenantId, created.body.id))!;
  const tenantId = project.tenantId;
  const owner = { kind: 'project' as const, id: project.id };
  const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'Owned', ownerSubject: owner, initialState: {} });
  const list = await createList(tenantId, orgId, 'user:x', { name: 'Scoped ideas', projectId: project.id });
  const ledger = await createLedger(project, 'user:x');
  const doc = await createDocument({ tenantId, orgId, title: 'Owned doc', kind: 'note', ownerSubject: owner, provenance: { producedBy: { kind: 'user', id: 'user:x' } }, createdBy: 'user:x' });
  // A control the cascade must NOT touch: an org document with no owner.
  const free = await createDocument({ tenantId, orgId, title: 'Org doc', kind: 'note', provenance: { producedBy: { kind: 'user', id: 'user:x' } }, createdBy: 'user:x' });
  return { c, tenantId, orgId, project, canvas, list, ledger, doc, free };
}

describe('ADR 0839 D2 — a project delete takes its dependents', () => {
  it('every owning feature registered (a forgotten registration is a stranded store)', () => {
    expect(listSubjectDependentKeys('project')).toEqual(['canvases', 'documents', 'entities', 'priorityLists', 'teamLedger', 'teamLedgerSuggestions']);
  });

  it('the delete preview names what will go, and a write is required to ask', async () => {
    const { c, tenantId, orgId, project } = await projectWithDependents();
    const r = await c.get<{ dependents: Counts }>(`${P}/${project.id}/delete-preview`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // teamLedger = the ledger row + its creation delta.
    expect(r.body.dependents).toEqual({ canvases: 1, documents: 1, entities: 0, priorityLists: 1, teamLedger: 2, teamLedgerSuggestions: 0 });
    // A CO-TENANT org viewer: the project is org-visible, so they hold READ — and the preview
    // still refuses them, because it needs WRITE. (A login in another tenant would 404 on
    // existence and prove nothing about the scope — the w13 probe showed exactly that.)
    const viewer = client();
    const login = await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `x-${Date.now()}-${n++}@acme.test`, tenantId });
    await createMember({ tenantId, orgId, subject: login.body.user.userId, displayName: 'V', roles: ['viewer'] });
    expect((await viewer.get(`${P}/${project.id}`)).status, 'control: the viewer really can READ the project').toBe(200);
    const refused = await viewer.get<{ error?: { code?: string } }>(`${P}/${project.id}/delete-preview`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('forbidden_scope');
  });

  it('BORN RED — the delete removes all four and reports them; an unowned row survives', async () => {
    const { c, tenantId, project, canvas, list, ledger, doc, free } = await projectWithDependents();
    const del = await c.del<{ dependentsDeleted: Counts }>(`${P}/${project.id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.dependentsDeleted).toEqual({ canvases: 1, documents: 1, entities: 0, priorityLists: 1, teamLedger: 2, teamLedgerSuggestions: 0 });

    expect(await getCanvasForTenant(tenantId, canvas.canvasId), 'owned canvas').toBeNull();
    expect(await getList(tenantId, list.id), 'scoped priority list').toBeNull();
    expect(await getBoard(list.boardId), 'and the list\'s own project-owned board').toBeNull();
    expect(await getLedger(tenantId, project.id), 'team ledger').toBeNull();
    expect(await listDeltas(tenantId, ledger.ledgerId), 'and its deltas').toEqual([]);
    expect(await getDocumentByIdForTenant(tenantId, doc.documentId), 'owned document').toBeNull();
    expect(await getDocumentByIdForTenant(tenantId, free.documentId), 'CONTROL: an unowned org document survives').toBeTruthy();
  });
});
