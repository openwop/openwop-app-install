/**
 * Research Notebooks — Transformations T2: apply-transformation (template → LLM →
 * Document) (ADR 0084 Transformations T2).
 *
 * Proves the route + catalog + Documents-output wiring WITHOUT a live model (the
 * run's Document output is simulated via documentsService.createDocument+addVersion
 * with ownerSubject=project:<id>, the effect the real `notebooks.transform` run's
 * write-transformation node has; the route's product path enqueues a real run,
 * asserted separately by runId):
 *   - POST .../transform is write-gated, returns a runId (202); bad templateId 400;
 *     unknown sid 404; cross-tenant 404.
 *   - GET .../transformations lists the owned transformation Documents.
 *   - GET .../transformations/templates returns the 5 catalog entries.
 *
 * Sabotage witnesses (w20g5-*): templates catalog sliced ⇒ case 1; templateId check / sid 404 /
 * write scope / run inputs ⇒ "transform enqueues a run"; the kind filter in listTransformations ⇒
 * the list case.
 *
 * @see docs/adr/0084-research-notebooks.md (Transformations T2)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Pass-through spy: the REAL run is enqueued; the spy lets "enqueues a run" assert WHICH workflow
// and WHICH inputs, not only that an id came back.
vi.mock('../src/host/runStarter.js', async (orig) => {
  const actual = await orig<typeof import('../src/host/runStarter.js')>();
  return { ...actual, startWorkflowRun: vi.fn(actual.startWorkflowRun) };
});
import { startWorkflowRun } from '../src/host/runStarter.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';

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
  for (const id of ['notebooks', 'kb', 'users', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(() => { vi.mocked(startWorkflowRun).mockClear(); });

interface Res { status: number; body: unknown }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
/** Narrow a JSON body at the transport boundary (a JSON round-trip, no type assertion). */
function body<T>(r: Res): T { return JSON.parse(JSON.stringify(r.body ?? null)); }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const tenantId = `t-${who}-${Date.now()}-${n++}`;
  const login = await c.post('/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: body<{ orgId: string }>(org).orgId, tenantId };
}
/** A co-tenant added to `orgId` as a read-only `viewer` (workspace:read, no :write) — the NB-2 pattern. */
async function viewerIn(owner: Client, tenantId: string, orgId: string): Promise<Client> {
  const v = client();
  const vu = await v.post('/host/openwop-app/test/login', { email: uniqEmail('nb-tx-viewer'), tenantId });
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: body<{ user: { userId: string } }>(vu).user.userId, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return v;
}
const notebookId = (r: Res): string => body<{ notebook: { id: string } }>(r).notebook.id;
const transformStarts = () => vi.mocked(startWorkflowRun).mock.calls.map((c) => c[1]).filter((i) => i.workflowId === 'notebooks.transform');
interface TxRow { documentId: string; title: string; kind: string; status: string; createdAt: string }

const NB = '/host/openwop-app/notebooks';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';

describe('notebooks — apply-transformation route + catalog (T2)', () => {
  it('templates endpoint returns the 5 catalog entries', async () => {
    const { c, orgId } = await ownerWithOrg('nb-tpl');
    const id = notebookId(await c.post(NB, { orgId, name: 'Pets research' }));
    const r = await c.get(`${NB}/${id}/transformations/templates`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const templates = body<{ templates: Array<{ id: string; label: string }> }>(r).templates;
    expect(templates.map((t) => t.id).sort()).toEqual(['key-concepts', 'methodology', 'questions', 'summary', 'takeaways']);
    expect(templates.find((t) => t.id === 'key-concepts')?.label).toBe('Key Concepts');
  });

  it('transform enqueues a run (write-gated, templateId-validated, sid-validated, cross-tenant 404)', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-tx');
    const id = notebookId(await c.post(NB, { orgId, name: 'Pets research' }));
    const cat = body<{ documentId: string }>(await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).documentId;

    // The product path enqueues a REAL `notebooks.transform` run for THIS source + template (202).
    const enq = await c.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'key-concepts' });
    expect(enq.status, JSON.stringify(enq.body)).toBe(202);
    expect(body<{ runId: string }>(enq).runId.length).toBeGreaterThan(0);
    expect(transformStarts()).toEqual([
      expect.objectContaining({
        tenantId,
        workflowId: 'notebooks.transform',
        inputs: expect.objectContaining({
          notebookId: id, sourceId: cat, orgId, kind: 'notebook-key-concepts', title: 'Key Concepts: Cat facts',
          ownerSubject: { kind: 'project', id },
        }),
      }),
    ]);

    // bad templateId ⇒ 400.
    expect((await c.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'nope' })).status).toBe(400);
    // missing templateId ⇒ 400 (requireString).
    expect((await c.post(`${NB}/${id}/sources/${cat}/transform`, {})).status).toBe(400);

    // unknown sid ⇒ 404.
    expect((await c.post(`${NB}/${id}/sources/ghost/transform`, { templateId: 'summary' })).status).toBe(404);

    // write-gated: a co-tenant read-only viewer gets 403 (it can read the notebook, so not 404).
    const viewer = await viewerIn(c, tenantId, orgId);
    expect((await viewer.get(`${NB}/${id}/transformations`)).status).toBe(200);
    expect((await viewer.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'summary' })).status).toBe(403);

    // cross-tenant caller ⇒ 404 (uniform IDOR — never reaches enqueue).
    const stranger = await ownerWithOrg('nb-tx-stranger');
    expect((await stranger.c.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'summary' })).status).toBe(404);
    expect(transformStarts()).toHaveLength(1); // no refused call enqueued anything
  });

  it('listTransformations returns the owned transformation Documents', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-tx-list');
    const id = notebookId(await c.post(NB, { orgId, name: 'Pets research' }));

    // Empty before any transformation.
    const before = await c.get(`${NB}/${id}/transformations`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(body<{ transformations: TxRow[] }>(before).transformations).toHaveLength(0);

    // Simulate the run's effect: a Document owned by project:<id>, kind notebook-*.
    const doc = await createDocument({
      tenantId, orgId, title: 'Key Concepts: Cat facts', kind: 'notebook-key-concepts', format: 'markdown',
      ownerSubject: projectSubject(id),
      provenance: { producedBy: { kind: 'run', id: 'run' } }, createdBy: 'run',
    });
    await addVersion(tenantId, orgId, doc.documentId, { content: '- Grooming\n- Purring', producedBy: { kind: 'run', id: 'run' } });

    // A non-transformation Document owned by the same project must NOT be listed.
    const other = await createDocument({
      tenantId, orgId, title: 'Unrelated', kind: 'doc', format: 'markdown',
      ownerSubject: projectSubject(id),
      provenance: { producedBy: { kind: 'run', id: 'run' } }, createdBy: 'run',
    });
    await addVersion(tenantId, orgId, other.documentId, { content: 'x', producedBy: { kind: 'run', id: 'run' } });

    const after = await c.get(`${NB}/${id}/transformations`);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const list = body<{ transformations: TxRow[] }>(after).transformations;
    expect(list.length).toBe(1);
    expect(list[0].documentId).toBe(doc.documentId);
    expect(list[0].kind).toBe('notebook-key-concepts');
    expect(list[0].title).toBe('Key Concepts: Cat facts');
    expect(list[0].status).toBe('draft');
    expect(typeof list[0].createdAt).toBe('string');

    // Read-gated: a stranger gets 404 (uniform IDOR).
    const stranger = await ownerWithOrg('nb-tx-list-stranger');
    expect((await stranger.c.get(`${NB}/${id}/transformations`)).status).toBe(404);
  });
});
