/**
 * Research Notebooks — per-source CONTEXT LEVELS (ADR 0084 Context Levels).
 *
 * Proves the Full / Excluded levels (Summary reserved-but-disabled):
 *   - PUT …/:id/sources/:sid/context-level sets a level (the level store is SoT)
 *   - 'excluded' drops the source from search + from the binding's excludeDocumentIds
 *   - listSources surfaces each source's contextLevel
 *   - setting back to 'full' restores it (search + binding)
 *   - unknown sid ⇒ 404; 'summary' ⇒ 400; cross-tenant caller ⇒ 404
 *   - a unit assertion that resolveSubjectKnowledgeRetrieve drops excluded chunks
 *
 * @see docs/adr/0084-research-notebooks.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { resolveSubjectKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import type { AgentMemoryPort } from '../src/host/agentDispatch.js';

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
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
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
const CANINE = 'Canine companions: dogs bark to communicate and wag their tail when happy.';

describe('notebooks — context levels (Full / Excluded)', () => {
  it('excludes a source from search + binding, restores on full, validates sid/level/tenant', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-ctx');
    const id = (await c.post(NB, { orgId, name: 'Pets research' })).body.notebook.id as string;

    const cat = (await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId as string;
    const dog = (await c.post(`${NB}/${id}/sources`, { title: 'Dog facts', text: CANINE })).body.documentId as string;

    // A freshly-added source defaults to 'full'.
    const initial = (await c.get(`${NB}/${id}/sources`)).body.sources as Array<{ documentId: string; contextLevel: string }>;
    expect(initial.every((s) => s.contextLevel === 'full')).toBe(true);

    // search finds both pets initially.
    const both = await c.post(`${NB}/${id}/search`, { query: 'pets cats dogs groom bark' });
    expect(both.body.hits.some((h: { documentId: string }) => h.documentId === cat)).toBe(true);
    expect(both.body.hits.some((h: { documentId: string }) => h.documentId === dog)).toBe(true);

    // (b) PUT cat → excluded; the response carries the new level.
    const put = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'excluded' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.contextLevel).toBe('excluded');

    // (a) it's gone from search; the dog remains.
    const afterExclude = await c.post(`${NB}/${id}/search`, { query: 'pets cats dogs groom bark' });
    expect(afterExclude.body.hits.some((h: { documentId: string }) => h.documentId === cat)).toBe(false);
    expect(afterExclude.body.hits.some((h: { documentId: string }) => h.documentId === dog)).toBe(true);
    expect(afterExclude.body.citations.some((cit: { documentId: string }) => cit.documentId === cat)).toBe(false);

    // (c) listSources shows the level.
    const listed = (await c.get(`${NB}/${id}/sources`)).body.sources as Array<{ documentId: string; contextLevel: string }>;
    expect(listed.find((s) => s.documentId === cat)?.contextLevel).toBe('excluded');
    expect(listed.find((s) => s.documentId === dog)?.contextLevel).toBe('full');

    // (c2) the DERIVED binding projection contains the excluded doc.
    const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
    expect(binding.retrieval?.excludeDocumentIds).toContain(cat);
    expect(binding.retrieval?.excludeDocumentIds).not.toContain(dog);
    // collectionIds are preserved (not wiped by the exclude write).
    expect((binding.collectionIds ?? []).length).toBeGreaterThanOrEqual(1);

    // (d) setting back to 'full' restores it in search + clears the binding projection.
    const back = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'full' });
    expect(back.status).toBe(200);
    expect(back.body.contextLevel).toBe('full');
    const restored = await c.post(`${NB}/${id}/search`, { query: 'pets cats dogs groom bark' });
    expect(restored.body.hits.some((h: { documentId: string }) => h.documentId === cat)).toBe(true);
    const binding2 = await getSubjectKnowledge(tenantId, projectSubject(id));
    expect(binding2.retrieval?.excludeDocumentIds ?? []).not.toContain(cat);

    // (e) unknown sid ⇒ 404.
    expect((await c.put(`${NB}/${id}/sources/does-not-exist/context-level`, { level: 'excluded' })).status).toBe(404);

    // (f) 'summary' ⇒ 400 (reserved, not yet selectable).
    const summary = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'summary' });
    expect(summary.status).toBe(400);

    // bad level ⇒ 400.
    expect((await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'bogus' })).status).toBe(400);

    // (g) cross-tenant caller ⇒ 404 (uniform IDOR).
    const stranger = await ownerWithOrg('nb-ctx-stranger');
    expect((await stranger.c.put(`${NB}/${id}/sources/${dog}/context-level`, { level: 'excluded' })).status).toBe(404);
  });

  // Review fix #2 — the binding projection is a read-modify-write; concurrent
  // level changes for the SAME notebook must CONVERGE (no lost update). The per-
  // notebook serialization makes every recompute read the full current store, so
  // firing N excludes at once ends with ALL N in the derived excludeDocumentIds.
  it('concurrent context-level writes converge — no lost update on the binding projection', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-ctx-race');
    const id = (await c.post(NB, { orgId, name: 'Race research' })).body.notebook.id as string;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await c.post(`${NB}/${id}/sources`, { title: `Src ${i}`, text: `${FELINE} ${i}` })).body.documentId as string);
    }
    // Fire all excludes concurrently.
    const results = await Promise.all(ids.map((sid) => c.put(`${NB}/${id}/sources/${sid}/context-level`, { level: 'excluded' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Every source landed in the derived projection — none lost to an interleaved overwrite.
    const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
    const excluded = new Set(binding.retrieval?.excludeDocumentIds ?? []);
    for (const sid of ids) expect(excluded.has(sid)).toBe(true);
  });
});

describe('agentKnowledgeComposition — excludeDocumentIds drops excluded chunks', () => {
  it('a binding excludeDocumentIds filters that document out of retrieval (generic seam)', async () => {
    // Ingest two docs via KB so the real backend (installed by the kb feature at boot)
    // is queried, then assert the generic retriever honors excludeDocumentIds.
    const { c, orgId, tenantId } = await ownerWithOrg('nb-unit');
    const id = (await c.post(NB, { orgId, name: 'Unit research' })).body.notebook.id as string;
    const cat = (await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId as string;
    await c.post(`${NB}/${id}/sources`, { title: 'Dog facts', text: CANINE });

    const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
    const collectionIds = binding.collectionIds ?? [];
    expect(collectionIds.length).toBeGreaterThanOrEqual(1);

    const noMemory: AgentMemoryPort = { read: async () => [], write: async () => undefined };

    // No exclusion: cat is retrievable.
    const open = resolveSubjectKnowledgeRetrieve(tenantId, { collectionIds, retrieval: { sources: ['kb'] } }, noMemory, 'scope');
    expect(open).toBeDefined();
    const openChunks = await open!('cats groom and purr');
    expect(openChunks.some((ch) => ch.content.includes('groom'))).toBe(true);

    // Exclude the cat document: its chunks are dropped.
    const filtered = resolveSubjectKnowledgeRetrieve(
      tenantId,
      { collectionIds, retrieval: { sources: ['kb'], excludeDocumentIds: [cat] } },
      noMemory,
      'scope',
    );
    const filteredChunks = await filtered!('cats groom and purr');
    expect(filteredChunks.some((ch) => ch.content.includes('groom'))).toBe(false);
  });
});
