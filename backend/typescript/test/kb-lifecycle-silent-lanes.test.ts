/**
 * ADR 0643 D3 — the knowledge-sync runner is a SILENT bulk lane, and (R3 review,
 * Blocker 2) it writes AS THE CONNECTION OWNER, re-resolved on every pass.
 *
 * `knowledge-sync-runner.test.ts` mocks `kbService` wholesale, so it can pin the
 * runner's CALL SHAPE but never what the real KB does with it. This file keeps the
 * real `kbService` (and the real dispatcher, captured) and mocks only the folder
 * listing + fetch, on the booted app (the project access resolver is registered
 * at boot, which is what makes a project-bound collection actually bound).
 *
 * Pinned:
 *   - a pass that ingests N files emits 0 per-file `document.ingested` and ONE
 *     `document.ingested { count: N }`; a pass that prunes emits nothing; an
 *     unchanged pass emits nothing (sabotage: drop the runner's `silent: true` ⇒
 *     the per-file count goes red);
 *   - a source whose CONNECTION OWNER is not a member of the project the target
 *     collection is bound to is REFUSED at the KB (the pass records the error and
 *     ingests nothing) while the same source under a member's connection ingests —
 *     the runner re-resolves at use instead of writing PREAUTHORIZED forever
 *     (sabotage: pass `PREAUTHORIZED_CALLER` in the runner again ⇒ red at "ingested 0").
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/features/connections/connectionsService.js', async (orig) => ({ ...(await orig<typeof import('../src/features/connections/connectionsService.js')>()), getConnection: vi.fn() }));
vi.mock('../src/host/knowledgeSourceFetch.js', async (orig) => ({ ...(await orig<typeof import('../src/host/knowledgeSourceFetch.js')>()), listFolder: vi.fn(), fetchKnowledgeSource: vi.fn(), fetchKnowledgeSourceBytes: vi.fn() }));
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { getConnection } from '../src/features/connections/connectionsService.js';
import { listFolder, fetchKnowledgeSource } from '../src/host/knowledgeSourceFetch.js';
import { runKnowledgeSyncOnce } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';
import { createSyncSource, syncDocumentId } from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { addProjectMember, createProject, setProjectVisibility, projectSubject } from '../src/features/projects/projectsService.js';
import { createCollection, getDocument, ingestMediaCollection, listDocuments } from '../src/features/kb/kbService.js';
import { createCollection as createMediaCollection, createAsset } from '../src/features/media/mediaService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

const mConn = vi.mocked(getConnection);
const mList = vi.mocked(listFolder);
const mFetch = vi.mocked(fetchKnowledgeSource);
const NOW = '2026-06-22T00:00:00.000Z';

let server: http.Server;
let app: Express;
let storage: Storage;
let BASE = '';
let n = 0;

/** A real tenant + org owner (the test-auth seam), so a PRIVATE project can carry a
 *  genuine member — `addProjectMember` refuses a principal who is not in the org. */
async function realMember(): Promise<{ tenantId: string; orgId: string; userId: string }> {
  let cookie = '';
  const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const tenantId = `org:kb-sync-bound-${Date.now()}-${n++}`;
  const login = await post('/v1/host/openwop-app/test/login', { email: `sync-member-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { tenantId, orgId: org.body.orgId as string, userId: login.body.user.userId as string };
}
let delivered: HostEventEnvelope[] = [];
const settle = () => new Promise((r) => setTimeout(r, 25));
const INGESTED = 'host.kb.document.ingested';
const kbEvents = (tenantId: string) => delivered.filter((e) => e.type.startsWith('host.kb.') && e.tenantId === tenantId);

const file = (id: string, rev: string) => ({ fileId: id, name: `${id}.doc`, mimeType: 'application/vnd.google-apps.document', revision: rev });
const listing = (files: ReturnType<typeof file>[], complete = true) => ({ files, complete });
const conn = (userId: string) => ({ connectionId: 'c1', tenantId: 't', userId, provider: 'google', kind: 'oauth2', displayName: 'D', status: 'active', scopes: [], connectedAt: NOW });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  initHostEventDispatcher({
    storage,
    hostSuite: app.locals.hostSuite as StartRunDeps['hostSuite'],
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async () => null,
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); delete process.env.OPENWOP_TEST_AUTH_ENABLED; });
beforeEach(() => {
  delivered = [];
  mConn.mockReset(); mList.mockReset(); mFetch.mockReset();
  mFetch.mockImplementation(async (_deps, ref) => ({ title: `Doc ${(ref as { ref: string }).ref}`, text: `hello world from ${(ref as { ref: string }).ref}` }) as never);
});

describe('ADR 0643 D3 — the sync runner is a silent bulk lane', () => {
  it('ingesting N files → 0 per-file ingested + ONE ingested { count: N }; a prune-only pass and an unchanged pass emit nothing', async () => {
    const tenantId = `kb-sync-silent-${Date.now()}-${n++}`;
    const orgId = 'org1';
    mConn.mockResolvedValue({ ...conn('user:owner'), tenantId } as never);
    const col = await createCollection(tenantId, orgId, 'user:owner', { name: 'Synced' });
    const source = await createSyncSource(tenantId, orgId, { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: col.collectionId, cadence: 'hourly' }, NOW);

    mList.mockResolvedValueOnce(listing([file('a', 'r1'), file('b', 'r1'), file('c', 'r1')]) as never);
    const first = await runKnowledgeSyncOnce({ storage }, source);
    expect(first.ingested, `errors: ${JSON.stringify(first.errors)}`).toBe(3);
    expect(await getDocument(tenantId, orgId, col.collectionId, syncDocumentId(source.id, 'a'), PREAUTHORIZED_CALLER), 'non-vacuity: the real KB holds the synced document').not.toBeNull();
    await settle();
    const perFile = delivered.filter((e) => e.type === INGESTED && e.tenantId === tenantId && typeof e.payload.documentId === 'string');
    expect(perFile, 'a folder of 10 000 files must not ignite 10 000 bound runs').toHaveLength(0);
    const batch = delivered.filter((e) => e.type === INGESTED && e.tenantId === tenantId && typeof e.payload.count === 'number');
    expect(batch).toHaveLength(1);
    expect(batch[0]!.payload).toEqual({ orgId, collectionId: col.collectionId, count: 3 });
    expect(kbEvents(tenantId)).toHaveLength(1);

    // Prune-only pass (b vanished): nothing.
    delivered = [];
    mList.mockResolvedValueOnce(listing([file('a', 'r1'), file('c', 'r1')]) as never);
    const second = await runKnowledgeSyncOnce({ storage }, source);
    expect(second).toMatchObject({ ingested: 0, pruned: 1 });
    await settle();
    expect(kbEvents(tenantId)).toEqual([]);

    // Unchanged pass: nothing.
    delivered = [];
    mList.mockResolvedValueOnce(listing([file('a', 'r1'), file('c', 'r1')]) as never);
    const third = await runKnowledgeSyncOnce({ storage }, source);
    expect(third).toMatchObject({ ingested: 0, pruned: 0 });
    await settle();
    expect(kbEvents(tenantId)).toEqual([]);
  });
});

describe('ADR 0643 R3 (Blocker 2) — the runner writes AS THE CONNECTION OWNER, re-resolved at use', () => {
  it('a project-BOUND target: the non-member owner\'s pass is refused (errors, 0 ingested); a member owner\'s pass ingests', async () => {
    const { tenantId, orgId, userId: member } = await realMember();
    const intruder = 'user:intruder'; // no membership anywhere in this tenant
    const project = await createProject(tenantId, orgId, { name: 'Private' });
    await addProjectMember(tenantId, project.id, `user:${member}`, 'contributor');
    await setProjectVisibility(tenantId, project.id, 'private');
    const col = await createCollection(tenantId, orgId, member, { name: 'private corpus' }, { boundSubject: projectSubject(project.id) });
    const source = await createSyncSource(tenantId, orgId, { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: col.collectionId, cadence: 'hourly' }, NOW);

    // The connection now belongs to a NON-member (the source's creator, whose
    // membership has since lapsed — or a connection re-bound underneath it).
    mConn.mockResolvedValue({ ...conn(intruder), tenantId } as never);
    mList.mockResolvedValueOnce(listing([file('a', 'r1')]) as never);
    // R4 Should 3 — refused BEFORE it pays: one thrown error (which `syncNow` counts
    // toward MAX_CONSECUTIVE_FAILURES and retires the source after 5), NO folder
    // listing, NO fetch. The R3 shape listed + fetched every changed file on every pass
    // and then recorded N per-file errors, forever.
    await expect(runKnowledgeSyncOnce({ storage }, { ...source, createdBy: intruder })).rejects.toThrow(/not readable by the connection owner/);
    expect(mList, 'the folder must not be listed for a source that cannot write').not.toHaveBeenCalled();
    expect(mFetch).not.toHaveBeenCalled();
    expect(await listDocuments(tenantId, orgId, col.collectionId, PREAUTHORIZED_CALLER)).toEqual([]);

    // Positive control — the same source under a MEMBER's connection ingests.
    mConn.mockResolvedValue({ ...conn(member), tenantId } as never);
    mList.mockResolvedValueOnce(listing([file('a', 'r1')]) as never);
    const ok = await runKnowledgeSyncOnce({ storage }, { ...source, createdBy: member });
    expect(ok.ingested, `errors: ${JSON.stringify(ok.errors)}`).toBe(1);
    expect((await listDocuments(tenantId, orgId, col.collectionId, PREAUTHORIZED_CALLER)).map((d) => d.documentId)).toEqual([syncDocumentId(source.id, 'a')]);
  });
});

describe('ADR 0643 D3 (R4 Should 2) — the media-collection bridge is a silent bulk lane', () => {
  it('ingesting N media assets → 0 per-asset ingested/updated + ONE ingested { count: N }; a re-run (idempotent upserts) emits nothing', async () => {
    const tenantId = `kb-media-silent-${Date.now()}-${n++}`;
    const orgId = 'org1';
    const kb = await createCollection(tenantId, orgId, 'actor', { name: 'From media' });
    const media = await createMediaCollection(tenantId, orgId, 'Uploads', 'actor');
    for (let i = 0; i < 3; i++) {
      const stored = await storeMediaAsset(tenantId, { contentBase64: Buffer.from(`Asset ${i} body: FlashPick robots pick frozen goods with accuracy ${i}.`).toString('base64'), contentType: 'text/plain' });
      await createAsset({ tenantId, orgId, collectionId: media.collectionId, name: `asset-${i}.txt`, contentType: 'text/plain', sizeBytes: stored.bytes, storageRef: stored.token, serveToken: stored.token, uploadedBy: 'actor' });
    }
    delivered = [];
    const result = await ingestMediaCollection(tenantId, orgId, 'actor', kb.collectionId, media.collectionId, PREAUTHORIZED_CALLER);
    expect(result.ingested, `skipped: ${JSON.stringify(result.skipped)}`).toBe(3);
    await settle();
    const perAsset = kbEvents(tenantId).filter((e) => typeof e.payload.documentId === 'string');
    expect(perAsset, 'a 500-asset collection must not start 500 bound runs').toHaveLength(0);
    const batch = kbEvents(tenantId).filter((e) => e.type === INGESTED && typeof e.payload.count === 'number');
    expect(batch).toHaveLength(1);
    expect(batch[0]!.payload).toEqual({ orgId, collectionId: kb.collectionId, count: 3 });
    expect(kbEvents(tenantId)).toHaveLength(1);

    // Re-run: every asset is a same-id, same-content upsert ⇒ no per-asset event, and
    // the pass still counts them as ingested (the bridge's own contract) ⇒ one batch.
    delivered = [];
    const again = await ingestMediaCollection(tenantId, orgId, 'actor', kb.collectionId, media.collectionId, PREAUTHORIZED_CALLER);
    expect(again.ingested).toBe(3);
    await settle();
    expect(kbEvents(tenantId).filter((e) => typeof e.payload.documentId === 'string')).toHaveLength(0);
  });
});
