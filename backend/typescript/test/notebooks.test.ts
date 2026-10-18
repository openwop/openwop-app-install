/**
 * Research Notebooks (ADR 0084) — ROUTE harness. Proves the thin vertical slice
 * composes the existing seams over a `facet:'notebook'` project Subject:
 *   - create  → project + KB collection + subject-knowledge binding
 *   - sources → KB ingest/list over the bound collection (synchronous embedder)
 *   - notes   → subject memory in the project:<id> scope
 *   - search  → KB semantic search over the collection (grounded hits + citations)
 *   - toggle-gated (404 while off); org-scoped RBAC + tenant IDOR (uniform 404)
 *
 * Every denial asserts that NOTHING LANDED (the owner re-reads), not only the
 * status. A cross-TENANT stranger is double-guarded (the tenant-scoped
 * `getProject` already reads null), so the `'none'` access branch and the list
 * filter are driven by a CO-TENANT user with no org membership (NB-2).
 *
 * Sabotage witnesses (grade-tests wave 20): dropping the write gate in
 * `requireNotebook` reds NB-2; dropping its `level === 'none'` half or the list
 * route's access filter reds NB-2's co-tenant leg; skipping `hasOrgScope` reds
 * the 403 case; dropping the ADR 0108 media guard reds the full slice (its
 * message is asserted, because kb would 415 an image anyway with OCR off);
 * ingesting sources trusted, a wrong citation title, or an empty notes list red
 * the full slice; a name-derived project id reds NB-3; dropping the STT budget,
 * shrinking the 48mb audio parser, or the 32 MiB route cap red the audio cases;
 * an ensure that re-provisions, or that lets a reader / stranger through, red
 * the ensure cases.
 *
 * The toggle is enabled via the `saveConfig` SERVICE (the global default), the
 * same mechanism the projects-route test uses — the HTTP admin PUT requires
 * superadmin, which a plain cookie session is not.
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
import type { Notebook, NotebookSource } from '../src/features/notebooks/notebooksService.js';
import type { SubjectNote } from '../src/host/subjectMemory.js';
import type { SearchHit } from '../src/features/kb/kbService.js';

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
  // Enable the feature globally (KB is needed for the bound collection + search).
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface LoginBody { user: { userId: string } }
interface OrgBody { orgId: string }
interface CreatedBody { notebook: Notebook; collectionId: string }
interface ListBody { notebooks: Notebook[] }
interface SourcesBody { sources: NotebookSource[] }
interface NotesBody { notes: SubjectNote[] }
interface SearchBody { hits: SearchHit[]; citations: Array<{ documentId: string; title: string }> }
interface ProjectBody { id: string }
interface EnsureBody { notebook: Notebook; collectionId: string }
interface RunBody { runId: string }
interface ErrorBody { error: string; message: string; details?: { kind?: string } }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
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
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

/** Owner + org + a read-only org `viewer` + a co-tenant user with NO org
 *  membership, all in ONE tenant (test/login defaults to a per-user personal
 *  tenant, so the tenant is explicit). The non-member is what reaches the
 *  `'none'` access branch — a cross-tenant stranger never does. */
async function sharedTenant(who: string): Promise<{ owner: Client; viewer: Client; outsider: Client; orgId: string }> {
  const tenantId = `t-${who}-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(`${who}-owner`), tenantId })).status).toBe(201);
  const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const viewer = client();
  const vu = await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(`${who}-viewer`), tenantId });
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: vu.body.user.userId, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const outsider = client();
  expect((await outsider.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(`${who}-outsider`), tenantId })).status).toBe(201);
  return { owner, viewer, outsider, orgId };
}

const NB = '/host/openwop-app/notebooks';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content. A cat sleeps for most of the day.';

describe('notebooks — full vertical slice (create → source → search → notes)', () => {
  it('create a notebook, add a text source, list sources, search hits, add+list notes', async () => {
    const { c, orgId } = await ownerWithOrg('nb-flow');

    // create = project (facet:notebook) + KB collection + binding
    const created = await c.post<CreatedBody>(NB, { orgId, name: 'Cats research' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.notebook.id;
    const collectionId = created.body.collectionId;
    expect(id).toBeTruthy();
    expect(collectionId).toBeTruthy();
    expect(created.body.notebook.collectionId).toBe(collectionId);

    // it appears in the list (only facet==='notebook' projects)
    const list = await c.get<ListBody>(NB);
    expect(list.body.notebooks.some((nb) => nb.id === id)).toBe(true);

    // add a text source (KB ingest via the synchronous local embedder)
    const src = await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE });
    expect(src.status, JSON.stringify(src.body)).toBe(201);

    // REPLAY GUARD (ADR 0108): a media upload to the (recorded-run-reachable) source
    // ingest is REJECTED — media→text is a live LLM call, replay-unsafe; it must go
    // through the recorded transcribe workflow, not the synchronous extractor.
    // kbService ALSO 415s an image while OCR is off (the default), so the status
    // alone cannot tell the two guards apart — the message names THIS guard.
    const media = await c.post<ErrorBody>(`${NB}/${id}/sources`, { title: 'scan', contentBase64: Buffer.from([0x89, 0x50]).toString('base64'), contentType: 'image/png' });
    expect(media.status).toBe(415);
    expect(media.body.message).toContain('audio-ingest route');

    // list sources — exactly the one text source (the media upload was rejected)
    const sources = await c.get<SourcesBody>(`${NB}/${id}/sources`);
    expect(sources.body.sources.length).toBe(1);
    expect(sources.body.sources[0].title).toBe('Cat facts');
    // notebook sources are third-party RAG material → ingested UNTRUSTED so
    // dispatch fences them (prompt-injection boundary; review follow-up #1).
    expect(sources.body.sources[0].contentTrust).toBe('untrusted');

    // search returns a hit + citations (grounded ask over the notebook)
    const search = await c.post<SearchBody>(`${NB}/${id}/search`, { query: 'how do cats groom and purr' });
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(search.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(search.body.citations.length).toBeGreaterThanOrEqual(1);
    expect(search.body.citations[0].title).toBe('Cat facts');

    // add a note (subject memory in project:<id> scope)
    const NOTE = 'Remember: cats sleep most of the day.';
    const note = await c.post<NotesBody>(`${NB}/${id}/notes`, { text: NOTE });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    expect(note.body.notes.length).toBe(1);

    // list notes — the same single note, by content
    expect((await c.get<NotesBody>(`${NB}/${id}/notes`)).body.notes.map((x) => x.content)).toEqual([NOTE]);
    // (Delete is witnessed in notebooks-delete-honesty.test.ts.)
  });
});

describe('notebooks — validation + RBAC', () => {
  it('rejects a missing name (400) and a write from an unscoped caller (403)', async () => {
    const { c, orgId } = await ownerWithOrg('nb-val');
    const noName = await c.post<ErrorBody>(NB, { orgId }); // no name
    expect(noName.status).toBe(400);
    expect(noName.body.error).toBe('validation_error');
    expect((await c.get<ListBody>(NB)).body.notebooks).toEqual([]);

    // An unscoped caller (no membership in orgId) cannot create.
    const anon = client();
    await anon.post('/host/openwop-app/test/login', { email: uniqEmail('nb-anon') });
    const denied = await anon.post<ErrorBody>(NB, { orgId, name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
    // …and nothing was provisioned in the caller's own tenant either.
    expect((await anon.get<ListBody>(NB)).body.notebooks).toEqual([]);
  });
});

describe('notebooks — org-scope + tenant IDOR (uniform 404)', () => {
  it('a different tenant cannot see or mutate a notebook', async () => {
    const a = await ownerWithOrg('nb-a');
    const id = (await a.c.post<CreatedBody>(NB, { orgId: a.orgId, name: 'A-notebook' })).body.notebook.id;

    // A different TENANT: the tenant-scoped `getProject` reads null, so every
    // door is a uniform 404 (the org-scoped `'none'` branch is NB-2's job).
    const stranger = await ownerWithOrg('nb-stranger');
    expect((await stranger.c.get(`${NB}/${id}`)).status).toBe(404);
    expect((await stranger.c.del(`${NB}/${id}`)).status).toBe(404);
    expect((await stranger.c.post(`${NB}/${id}/sources`, { text: 'leak?' })).status).toBe(404);
    expect((await stranger.c.get(`${NB}/${id}/notes`)).status).toBe(404);
    expect((await stranger.c.get<ListBody>(NB)).body.notebooks.some((nb) => nb.id === id)).toBe(false);
    // …and the stranger's DELETE / source write did not land.
    expect((await a.c.get(`${NB}/${id}`)).status).toBe(200);
    expect((await a.c.get<SourcesBody>(`${NB}/${id}/sources`)).body.sources).toEqual([]);
  });
});

describe('notebooks — same-tenant RBAC (read-only member ⇒ 403, not 404)', () => {
  it('NB-2: a workspace:read viewer can READ a notebook but every WRITE op is 403 (not 404)', async () => {
    const { owner, viewer, outsider, orgId } = await sharedTenant('nb-rbac');
    const id = (await owner.post<CreatedBody>(NB, { orgId, name: 'Shared notebook' })).body.notebook.id;

    // READS succeed (the viewer has access — so a write denial must be 403, never a 404 leak).
    expect((await viewer.get<Notebook>(`${NB}/${id}`)).body.id).toBe(id);
    expect((await viewer.get<SourcesBody>(`${NB}/${id}/sources`)).body.sources).toEqual([]);
    expect((await viewer.get<ListBody>(NB)).body.notebooks.map((nb) => nb.id)).toEqual([id]);
    // WRITES are forbidden by scope — 403, distinguishing "you can't write" from "doesn't exist".
    const src = await viewer.post<ErrorBody>(`${NB}/${id}/sources`, { text: 'nope' });
    expect(src.status).toBe(403);
    expect(src.body.error).toBe('forbidden_scope');
    expect((await viewer.post(`${NB}/${id}/notes`, { text: 'nope' })).status).toBe(403);
    expect((await viewer.del(`${NB}/${id}`)).status).toBe(403);
    // …and none of the denied writes landed.
    expect((await owner.get<SourcesBody>(`${NB}/${id}/sources`)).body.sources).toEqual([]);
    expect((await owner.get<NotesBody>(`${NB}/${id}/notes`)).body.notes).toEqual([]);
    expect((await owner.get(`${NB}/${id}`)).status).toBe(200);

    // A CO-TENANT user with no org membership resolves NO access: uniform 404 on
    // the doors, and the list drops the notebook (the `'none'` branch + filter).
    expect((await outsider.get(`${NB}/${id}`)).status).toBe(404);
    expect((await outsider.post(`${NB}/${id}/notes`, { text: 'leak?' })).status).toBe(404);
    expect((await outsider.get<ListBody>(NB)).body.notebooks).toEqual([]);
    expect((await owner.get<NotesBody>(`${NB}/${id}/notes`)).body.notes).toEqual([]);
  });
});

describe('notebooks — create is not falsely deduped', () => {
  it('NB-3: two notebooks with the same name are distinct (independent project + KB collection)', async () => {
    const { c, orgId } = await ownerWithOrg('nb-dup');
    const a = await c.post<CreatedBody>(NB, { orgId, name: 'Same name' });
    const b = await c.post<CreatedBody>(NB, { orgId, name: 'Same name' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.notebook.id).not.toBe(b.body.notebook.id);
    expect(a.body.collectionId).not.toBe(b.body.collectionId); // each owns its own sources collection
    expect((await c.get<ListBody>(NB)).body.notebooks.filter((nb) => nb.name === 'Same name').length).toBe(2);
  });
});

describe('notebooks — audio STT budget pre-flight (ADR 0106 Phase 2)', () => {
  it('rejects an over-budget audio upload with 429 (rate_limited) before enqueue, admits under budget', async () => {
    const { c, orgId } = await ownerWithOrg('nb-stt-budget');
    const id = (await c.post<CreatedBody>(NB, { orgId, name: 'Recordings' })).body.notebook.id;
    const contentBase64 = Buffer.from('x'.repeat(200)).toString('base64'); // ~200 decoded bytes
    process.env.OPENWOP_MEDIA_DAILY_STT_BYTES = '10';
    try {
      const over = await c.post<ErrorBody>(`${NB}/${id}/sources/audio`, { title: 'Big', contentBase64, contentType: 'audio/mpeg' });
      expect(over.status, JSON.stringify(over.body)).toBe(429);
      expect(over.body.error).toBe('rate_limited');
      expect(over.body.details?.kind).toBe('stt');
    } finally {
      delete process.env.OPENWOP_MEDIA_DAILY_STT_BYTES;
    }
    // With the budget unset, the same upload enqueues a run (202).
    const ok = await c.post<RunBody>(`${NB}/${id}/sources/audio`, { title: 'Fine', contentBase64, contentType: 'audio/mpeg' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect(ok.body.runId).toBeTruthy();
  });
});

describe('notebooks — audio upload body limit (MEDIA-2)', () => {
  it('admits a multi-MB audio body (above the global 1mb JSON limit) and enqueues a run', async () => {
    const { c, orgId } = await ownerWithOrg('nb-audio-ok');
    const id = (await c.post<CreatedBody>(NB, { orgId, name: 'Recordings' })).body.notebook.id;
    // ~2 MB of valid base64 — before MEDIA-2 the global 1mb parser 413'd this
    // before the route ever ran. Now the scoped 48mb parser admits it and the
    // route enqueues the ingest run (202 + runId). 2 MiB decoded ≪ the 32 MiB cap.
    const contentBase64 = 'A'.repeat(2 * 1024 * 1024);
    const res = await c.post<RunBody>(`${NB}/${id}/sources/audio`, { title: 'Standup', contentBase64, contentType: 'audio/mpeg' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.runId).toBeTruthy();
  });

  it('rejects an over-cap audio body with 413 at the route (not a generic parser error)', async () => {
    const { c, orgId } = await ownerWithOrg('nb-audio-big');
    const id = (await c.post<CreatedBody>(NB, { orgId, name: 'Recordings' })).body.notebook.id;
    // 45 MiB of base64 ≈ 35.4 MiB decoded — admitted by the 48mb parser, then
    // rejected by the route's own 32 MiB decoded guard with a structured 413.
    const contentBase64 = 'A'.repeat(45 * 1024 * 1024);
    const res = await c.post<ErrorBody>(`${NB}/${id}/sources/audio`, { title: 'Too long', contentBase64, contentType: 'audio/mpeg' });
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.error).toBe('validation_error'); // envelope: { error: <code>, ... }
  });
});

describe('notebooks — Sources-on-any-project (ADR 0084 correction)', () => {
  it('POST /:id/ensure provisions sources on a plain project, which then resolves as a notebook', async () => {
    const { c, orgId } = await ownerWithOrg('nb-ensure');
    const plain = await c.post<ProjectBody>('/host/openwop-app/projects', { orgId, name: 'Regular project' });
    expect(plain.status).toBe(201);
    const id = plain.body.id;
    // Before ensure: not a notebook (no bound collection).
    expect((await c.get(`${NB}/${id}`)).status).toBe(404);
    // Ensure → provisions a KB collection + binding (idempotent).
    const ens = await c.post<EnsureBody>(`${NB}/${id}/ensure`);
    expect(ens.status, JSON.stringify(ens.body)).toBe(200);
    expect(ens.body.collectionId).toBeTruthy();
    const ens2 = await c.post<EnsureBody>(`${NB}/${id}/ensure`); // idempotent — same collection
    expect(ens2.body.collectionId).toBe(ens.body.collectionId);
    // Now it resolves as a notebook + accepts a source.
    expect((await c.get(`${NB}/${id}`)).status).toBe(200);
    const src = await c.post(`${NB}/${id}/sources`, { title: 'Doc', text: 'The mitochondria is the powerhouse of the cell.' });
    expect(src.status).toBe(201);
    expect((await c.get<SourcesBody>(`${NB}/${id}/sources`)).body.sources.length).toBe(1);
  });

  it('ensure requires workspace:write in the project org (403 for a reader, 404 cross-tenant)', async () => {
    // A READER (org viewer, same tenant) is refused with 403 and provisions nothing.
    const { owner, viewer, orgId } = await sharedTenant('nb-ensure-r');
    const shared = await owner.post<ProjectBody>('/host/openwop-app/projects', { orgId, name: 'Shared proj' });
    expect(shared.status).toBe(201);
    const denied = await viewer.post<ErrorBody>(`${NB}/${shared.body.id}/ensure`);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
    expect((await owner.get(`${NB}/${shared.body.id}`)).status, 'a refused ensure must not provision').toBe(404);

    const a = await ownerWithOrg('nb-ensure-a');
    const b = await ownerWithOrg('nb-ensure-b');
    const proj = await a.c.post<ProjectBody>('/host/openwop-app/projects', { orgId: a.orgId, name: 'A proj' });
    // b (different tenant) cannot ensure a's project → uniform 404, and nothing is provisioned.
    expect((await b.c.post(`${NB}/${proj.body.id}/ensure`)).status).toBe(404);
    expect((await a.c.get(`${NB}/${proj.body.id}`)).status).toBe(404);
  });
});
