/**
 * Research Notebooks — per-source CONTEXT LEVELS (ADR 0084 Context Levels).
 *
 * Proves the Full / Excluded levels (the Summary level — un-gated once a summary
 * exists — is witnessed in `notebooks-summarize-t1.test.ts`):
 *   - PUT …/:id/sources/:sid/context-level sets a level (the level store is SoT)
 *   - 'excluded' drops the source from search + from the binding's excludeDocumentIds
 *   - listSources surfaces each source's contextLevel
 *   - setting back to 'full' restores it (search + binding)
 *   - unknown sid ⇒ 404; 'summary' with no summary ⇒ 400; bad level ⇒ 400;
 *     cross-tenant caller ⇒ 404
 *   - concurrent level writes CONVERGE: the race is FORCED (a parked binding
 *     write), not hoped for
 *   - a unit assertion that resolveSubjectKnowledgeRetrieve drops excluded chunks
 *
 * Sabotage witnesses (grade-tests wave 20): not filtering excluded hits in
 * `searchNotebook`, not deriving `excluded` into the projection, listing every
 * source as 'full', skipping the recompute on 'full', dropping the level
 * allowlist or the unknown-sid 404 all red case 1; removing the per-notebook
 * recompute tail (`projectionTails`) reds case 2; dropping the generic seam's
 * excludeDocumentIds filter reds case 3. The 'summary'-without-summary 400 is a
 * DOUBLE guard (route + `setSourceContextLevel`), so neither half alone reds it.
 *
 * @see docs/adr/0084-research-notebooks.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** A parked binding write, armed for one subject: it holds the FIRST
 *  `setSubjectKnowledge` for that subject until released, so a second level
 *  write can run its whole recompute inside the window — the lost-update race,
 *  forced. Pass-through when unarmed. */
const gate = vi.hoisted(() => ({ subjectId: null as string | null, fired: 0, release: null as (() => void) | null }));
vi.mock('../src/host/subjectKnowledge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/subjectKnowledge.js')>();
  return {
    ...actual,
    setSubjectKnowledge: async (...args: Parameters<typeof actual.setSubjectKnowledge>) => {
      if (gate.subjectId !== null && args[1].id === gate.subjectId) {
        gate.subjectId = null;
        gate.fired++;
        await new Promise<void>((r) => { gate.release = r; });
      }
      return actual.setSubjectKnowledge(...args);
    },
  };
});

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { resolveSubjectKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import type { AgentMemoryPort } from '../src/host/agentDispatch.js';
import { setSourceContextLevel, type NotebookSource } from '../src/features/notebooks/notebooksService.js';

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
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface OrgBody { orgId: string }
interface CreatedBody { notebook: { id: string }; collectionId: string }
interface DocBody { documentId: string }
interface SourcesBody { sources: NotebookSource[] }
interface SearchBody { hits: Array<{ documentId: string }>; citations: Array<{ documentId: string }> }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
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
    put: <T = unknown>(p: string, b?: unknown) => call<T>('PUT', p, b),
  };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const tenantId = `t-${who}-${Date.now()}-${n++}`;
  const login = await c.post('/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId, tenantId };
}

const NB = '/host/openwop-app/notebooks';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';
const CANINE = 'Canine companions: dogs bark to communicate and wag their tail when happy.';

describe('notebooks — context levels (Full / Excluded)', () => {
  it('excludes a source from search + binding, restores on full, validates sid/level/tenant', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-ctx');
    const created = (await c.post<CreatedBody>(NB, { orgId, name: 'Pets research' })).body;
    const id = created.notebook.id;

    const cat = (await c.post<DocBody>(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId;
    const dog = (await c.post<DocBody>(`${NB}/${id}/sources`, { title: 'Dog facts', text: CANINE })).body.documentId;

    // A freshly-added source defaults to 'full'.
    const initial = (await c.get<SourcesBody>(`${NB}/${id}/sources`)).body.sources;
    expect(initial.length).toBe(2);
    expect(initial.every((s) => s.contextLevel === 'full')).toBe(true);

    // search finds both pets initially.
    const both = await c.post<SearchBody>(`${NB}/${id}/search`, { query: 'pets cats dogs groom bark' });
    expect(both.body.hits.some((h) => h.documentId === cat)).toBe(true);
    expect(both.body.hits.some((h) => h.documentId === dog)).toBe(true);

    // (b) PUT cat → excluded; the response carries the new level.
    const put = await c.put<NotebookSource>(`${NB}/${id}/sources/${cat}/context-level`, { level: 'excluded' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.contextLevel).toBe('excluded');

    // (a) it's gone from search; the dog remains.
    const afterExclude = await c.post<SearchBody>(`${NB}/${id}/search`, { query: 'pets cats dogs groom bark' });
    expect(afterExclude.body.hits.some((h) => h.documentId === cat)).toBe(false);
    expect(afterExclude.body.hits.some((h) => h.documentId === dog)).toBe(true);
    expect(afterExclude.body.citations.some((cit) => cit.documentId === cat)).toBe(false);

    // (c) listSources shows the level.
    const listed = (await c.get<SourcesBody>(`${NB}/${id}/sources`)).body.sources;
    expect(listed.find((s) => s.documentId === cat)?.contextLevel).toBe('excluded');
    expect(listed.find((s) => s.documentId === dog)?.contextLevel).toBe('full');

    // (c2) the DERIVED binding projection contains the excluded doc.
    const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
    expect(binding.retrieval?.excludeDocumentIds).toContain(cat);
    expect(binding.retrieval?.excludeDocumentIds).not.toContain(dog);
    // collectionIds are preserved (not wiped by the exclude write).
    expect(binding.collectionIds).toEqual([created.collectionId]);

    // (d) setting back to 'full' restores it in search + clears the binding projection.
    const back = await c.put<NotebookSource>(`${NB}/${id}/sources/${cat}/context-level`, { level: 'full' });
    expect(back.status).toBe(200);
    expect(back.body.contextLevel).toBe('full');
    const restored = await c.post<SearchBody>(`${NB}/${id}/search`, { query: 'pets cats dogs groom bark' });
    expect(restored.body.hits.some((h) => h.documentId === cat)).toBe(true);
    const binding2 = await getSubjectKnowledge(tenantId, projectSubject(id));
    expect(binding2.retrieval?.excludeDocumentIds ?? []).not.toContain(cat);

    // (e) unknown sid ⇒ 404.
    expect((await c.put(`${NB}/${id}/sources/does-not-exist/context-level`, { level: 'excluded' })).status).toBe(404);

    // (f) 'summary' with NO stored summary ⇒ 400 (double guard: route + service).
    const summary = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'summary' });
    expect(summary.status).toBe(400);

    // bad level ⇒ 400.
    expect((await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'bogus' })).status).toBe(400);

    // (g) cross-tenant caller ⇒ 404 (uniform IDOR).
    const stranger = await ownerWithOrg('nb-ctx-stranger');
    expect((await stranger.c.put(`${NB}/${id}/sources/${dog}/context-level`, { level: 'excluded' })).status).toBe(404);
  });

  // Review fix #2 — the binding projection is a read-modify-write; concurrent
  // level changes for the SAME notebook must CONVERGE (no lost update). The window
  // is FORCED: write A's recompute is parked at its binding write (having derived
  // `{A}`), write B runs inside it, then A resumes. Without the per-notebook
  // serialization B writes `{A,B}` and parked A then overwrites it with the stale
  // `{A}`; with it, B's recompute waits for A and re-reads the full level store.
  it('concurrent context-level writes converge — no lost update on the binding projection', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-ctx-race');
    const id = (await c.post<CreatedBody>(NB, { orgId, name: 'Race research' })).body.notebook.id;
    const a = (await c.post<DocBody>(`${NB}/${id}/sources`, { title: 'Src A', text: `${FELINE} A` })).body.documentId;
    const b = (await c.post<DocBody>(`${NB}/${id}/sources`, { title: 'Src B', text: `${CANINE} B` })).body.documentId;

    const drain = async (ticks: number): Promise<void> => { for (let i = 0; i < ticks; i++) await new Promise<void>((r) => setImmediate(r)); };
    gate.subjectId = id;
    const writeA = setSourceContextLevel(tenantId, id, a, 'excluded');
    await vi.waitFor(() => expect(gate.fired, 'write A must park at its binding write').toBe(1));
    let bSettled = false;
    const writeB = setSourceContextLevel(tenantId, id, b, 'excluded').finally(() => { bSettled = true; });
    // Give B every chance to finish inside the window (it can only when unserialized).
    for (let i = 0; i < 50 && !bSettled; i++) await drain(1);
    gate.release!();
    await Promise.all([writeA, writeB]);

    const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
    const excluded = new Set(binding.retrieval?.excludeDocumentIds ?? []);
    expect(excluded.has(a), 'A').toBe(true);
    expect(excluded.has(b), 'B — lost to a stale overwrite if the recompute is unserialized').toBe(true);
  });
});

describe('agentKnowledgeComposition — excludeDocumentIds drops excluded chunks', () => {
  it('a binding excludeDocumentIds filters that document out of retrieval (generic seam)', async () => {
    // Ingest two docs via KB so the real backend (installed by the kb feature at boot)
    // is queried, then assert the generic retriever honors excludeDocumentIds.
    const { c, orgId, tenantId } = await ownerWithOrg('nb-unit');
    const id = (await c.post<CreatedBody>(NB, { orgId, name: 'Unit research' })).body.notebook.id;
    const cat = (await c.post<DocBody>(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId;
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
