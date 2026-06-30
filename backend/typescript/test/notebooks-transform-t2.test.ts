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
 * @see docs/adr/0084-research-notebooks.md (Transformations T2)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
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
  const login = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId, tenantId };
}

const NB = '/v1/host/openwop-app/notebooks';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';

describe('notebooks — apply-transformation route + catalog (T2)', () => {
  it('templates endpoint returns the 5 catalog entries', async () => {
    const { c, orgId } = await ownerWithOrg('nb-tpl');
    const id = (await c.post(NB, { orgId, name: 'Pets research' })).body.notebook.id as string;
    const r = await c.get(`${NB}/${id}/transformations/templates`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = (r.body.templates as Array<{ id: string; label: string }>).map((t) => t.id).sort();
    expect(ids).toEqual(['key-concepts', 'methodology', 'questions', 'summary', 'takeaways']);
    expect((r.body.templates as Array<{ label: string }>).every((t) => typeof t.label === 'string' && t.label.length > 0)).toBe(true);
  });

  it('transform enqueues a run (write-gated, templateId-validated, sid-validated, cross-tenant 404)', async () => {
    const { c, orgId } = await ownerWithOrg('nb-tx');
    const id = (await c.post(NB, { orgId, name: 'Pets research' })).body.notebook.id as string;
    const cat = (await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId as string;

    // The product path enqueues a REAL run and returns its id (202).
    const enq = await c.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'key-concepts' });
    expect(enq.status, JSON.stringify(enq.body)).toBe(202);
    expect(typeof enq.body.runId).toBe('string');
    expect(enq.body.runId.length).toBeGreaterThan(0);

    // bad templateId ⇒ 400.
    expect((await c.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'nope' })).status).toBe(400);
    // missing templateId ⇒ 400 (requireString).
    expect((await c.post(`${NB}/${id}/sources/${cat}/transform`, {})).status).toBe(400);

    // unknown sid ⇒ 404.
    expect((await c.post(`${NB}/${id}/sources/ghost/transform`, { templateId: 'summary' })).status).toBe(404);

    // cross-tenant caller ⇒ 404 (uniform IDOR — never reaches enqueue).
    const stranger = await ownerWithOrg('nb-tx-stranger');
    expect((await stranger.c.post(`${NB}/${id}/sources/${cat}/transform`, { templateId: 'summary' })).status).toBe(404);
  });

  it('listTransformations returns the owned transformation Documents', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-tx-list');
    const id = (await c.post(NB, { orgId, name: 'Pets research' })).body.notebook.id as string;

    // Empty before any transformation.
    const before = await c.get(`${NB}/${id}/transformations`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect((before.body.transformations as unknown[]).length).toBe(0);

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
    const list = after.body.transformations as Array<{ documentId: string; title: string; kind: string; status: string; createdAt: string }>;
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
