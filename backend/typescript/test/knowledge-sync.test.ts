/**
 * ADR 0107 Phase 2 — the knowledge-sync feature-package (config layer). Two parts:
 *  (a) the service CRUD + diff-state store (createSyncSource validation, org-filtered
 *      list, cross-tenant null, status, delete-cascades-file-state);
 *  (b) the routes' gating — toggle 404, missing-org 400, non-existent-connection 404,
 *      cross-tenant IDOR 404. The 201 happy-path seeds a Google OAuth connection
 *      (built-in `google` provider) + a KB collection, incl. the folder-URL→id
 *      normalization (ADR 0107 follow-on).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  createSyncSource, listSyncSources, getSyncSource, setSyncStatus, deleteSyncSource,
  listFileStates, upsertFileState, diffFolder, syncDocumentId,
  type RemoteFile, type SyncFileState,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';
import { createCollection } from '../src/features/kb/kbService.js';

const NOW = '2026-06-22T00:00:00.000Z';

describe('diffFolder (ADR 0107 Phase 3 — the correctness-critical diff)', () => {
  const rf = (fileId: string, revision: string, over: Partial<RemoteFile> = {}): RemoteFile =>
    ({ fileId, name: `${fileId}.txt`, mimeType: 'text/plain', revision, ...over });
  const st = (sourceId: string, fileId: string, revision: string): SyncFileState =>
    ({ sourceId, externalFileId: fileId, documentId: syncDocumentId(sourceId, fileId), revision });

  it('classifies NEW / CHANGED / UNCHANGED / DELETED', () => {
    const remote = [rf('a', 'r1'), rf('b', 'r2-NEW'), rf('c', 'r3')]; // a unchanged, b changed, c unchanged-then-... wait
    const states = [st('S', 'a', 'r1'), st('S', 'b', 'r2-OLD'), st('S', 'd', 'r4')]; // a same, b differs, d gone
    const d = diffFolder('S', remote, states);
    // a: revision matches → unchanged; c: no prior state → new; b: revision differs → changed
    expect(d.toIngest.map((x) => `${x.fileId}:${x.reason}`).sort()).toEqual(['b:changed', 'c:new']);
    expect(d.unchanged).toBe(1); // a
    // d existed in state but is gone from the folder → prune
    expect(d.toPrune).toEqual([{ fileId: 'd', documentId: syncDocumentId('S', 'd') }]);
    // ingest carries the STABLE documentId
    expect(d.toIngest.find((x) => x.fileId === 'c')!.documentId).toBe(syncDocumentId('S', 'c'));
  });

  it('an empty folder prunes all known files; an empty state ingests all as new', () => {
    expect(diffFolder('S', [], [st('S', 'x', 'r')]).toPrune.map((p) => p.fileId)).toEqual(['x']);
    const allNew = diffFolder('S', [rf('y', 'r')], []);
    expect(allNew.toIngest.map((i) => i.reason)).toEqual(['new']);
    expect(allNew.toPrune).toEqual([]);
  });

  it('is idempotent — re-diffing after the state is updated yields no work', () => {
    const remote = [rf('a', 'r1')];
    const after = diffFolder('S', remote, [st('S', 'a', 'r1')]);
    expect(after.toIngest).toEqual([]);
    expect(after.toPrune).toEqual([]);
    expect(after.unchanged).toBe(1);
  });

  it('skips a malformed remote entry (no fileId)', () => {
    const d = diffFolder('S', [{ fileId: '', name: 'x', mimeType: 't', revision: 'r' }], []);
    expect(d.toIngest).toEqual([]);
  });
});

describe('knowledgeSyncService (ADR 0107 Phase 2 — CRUD + diff state)', () => {
  it('creates a source, lists by org, reads cross-tenant as null', async () => {
    const s = await createSyncSource('tA', 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F1', collectionId: 'col1', cadence: 'hourly' }, NOW);
    expect(s.status).toBe('active');
    expect(s.orgId).toBe('org1');
    expect((await listSyncSources('tA', 'org1')).some((x) => x.id === s.id)).toBe(true);
    expect((await listSyncSources('tA', 'other-org')).some((x) => x.id === s.id)).toBe(false); // org-filtered
    expect(await getSyncSource('tB', s.id)).toBeNull(); // cross-tenant fail-closed
  });

  it('rejects an unsupported provider or cadence', async () => {
    await expect(createSyncSource('tA', 'o', { connectionId: 'c', provider: 'mega', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(createSyncSource('tA', 'o', { connectionId: 'c', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'every-second' }, NOW))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('pauses/resumes via status and cascades file-state on delete', async () => {
    const s = await createSyncSource('tA', 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F1', collectionId: 'col1', cadence: 'daily' }, NOW);
    await upsertFileState({ sourceId: s.id, externalFileId: 'fileA', documentId: `sync:${s.id}:fileA`, revision: 'r1' });
    expect((await listFileStates(s.id)).length).toBe(1);

    const paused = await setSyncStatus('tA', s.id, 'paused', NOW);
    expect(paused?.status).toBe('paused');

    expect(await deleteSyncSource('tA', s.id)).toBe(true);
    expect(await getSyncSource('tA', s.id)).toBeNull();
    expect((await listFileStates(s.id)).length).toBe(0); // cursor rows cascaded
    expect(await deleteSyncSource('tA', s.id)).toBe(false); // already gone
  });
});

// ── route gating ─────────────────────────────────────────────────────────────

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
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const uniqEmail = (who: string) => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string) {
  const c = client();
  await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who) });
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId as string };
}
const KS = '/v1/host/openwop-app/knowledge-sync';

async function enableToggle(on: boolean) {
  const d = getToggleDefault('knowledge-sync');
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

describe('knowledge-sync routes — gating (ADR 0107 Phase 2)', () => {
  beforeEach(() => enableToggle(true));

  it('404s every route while the toggle is OFF', async () => {
    await enableToggle(false);
    const { c, orgId } = await ownerWithOrg('ks-off');
    expect((await c.get(`${KS}?orgId=${orgId}`)).status).toBe(404);
    expect((await c.post(KS, { orgId })).status).toBe(404);
  });

  it('rejects a create with no orgId (400) and a non-existent connection (404)', async () => {
    const { c, orgId } = await ownerWithOrg('ks-val');
    expect((await c.post(KS, {})).status).toBe(400); // no orgId
    const r = await c.post(KS, { orgId, connectionId: 'conn:does-not-exist', collectionId: 'col', provider: 'google', externalFolderId: 'F', cadence: 'hourly' });
    expect(r.status, JSON.stringify(r.body)).toBe(404); // connection not found
    expect(r.body.error).toBe('not_found');
  });

  it('GET /browse — toggle-gated, requires orgId, 404 on an unknown connection', async () => {
    await enableToggle(false);
    const off = await ownerWithOrg('ks-browse-off');
    expect((await off.c.get(`${KS}/browse?orgId=${off.orgId}&connectionId=c`)).status).toBe(404); // toggle off
    await enableToggle(true);
    const { c, orgId } = await ownerWithOrg('ks-browse');
    expect((await c.get(`${KS}/browse?connectionId=c`)).status).toBe(400); // no orgId
    expect((await c.get(`${KS}/browse?orgId=${orgId}&connectionId=conn:nope`)).status).toBe(404); // unknown connection
  });

  it('cross-tenant IDOR: a stranger gets a uniform 404 for another tenant\'s source', async () => {
    const { c: stranger } = await ownerWithOrg('ks-stranger');
    // seed a source for an unrelated tenant directly via the service
    const seeded = await createSyncSource('tenant-victim', 'org-v', { connectionId: 'c', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    expect((await stranger.get(`${KS}/${seeded.id}`)).status).toBe(404);
    expect((await stranger.del(`${KS}/${seeded.id}`)).status).toBe(404);
  });
});

describe('create normalizes a Google Drive folder URL (ADR 0107 follow-on)', () => {
  beforeEach(() => enableToggle(true));
  const FOLDER_ID = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

  async function seededOrg(who: string): Promise<{ c: ReturnType<typeof client>; orgId: string; connectionId: string; collectionId: string }> {
    const tenantId = `org:${who}-${Date.now()}-${n++}`;
    const c = client();
    await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
    const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
    // seed a Google OAuth connection + a KB collection in this tenant/org (Phase 4
    // is satisfied by the built-in `google` provider, so this resolves).
    const conn = await upsertOAuthConnection({ tenantId, provider: 'google', orgId, tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/drive.readonly'] } });
    const col = await createCollection(tenantId, orgId, 'test', { name: 'Sources' });
    return { c, orgId, connectionId: conn.connectionId, collectionId: col.collectionId };
  }

  it('stores the BARE folder id when a folder URL is pasted', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-url-ok');
    const r = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`, cadence: 'hourly' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.source.externalFolderId).toBe(FOLDER_ID); // URL normalized server-side
  });

  it('persists the per-source includeMedia opt-out through the route (ADR 0108 OQ-3)', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-media');
    // explicit opt-out → stored false on the source
    const off = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: FOLDER_ID, cadence: 'hourly', includeMedia: false });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(off.body.source.includeMedia).toBe(false);
    // omitted ⇒ media included (the field is simply absent; the runner treats absent as true)
    const on = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: FOLDER_ID, cadence: 'daily' });
    expect(on.body.source.includeMedia).toBeUndefined();
  });

  it('PATCH /:id toggles includeMedia on an existing source without recreate (ADR 0108 OQ-3 follow-on)', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-patch');
    const created = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: FOLDER_ID, cadence: 'daily' });
    const id = created.body.source.id as string;
    expect(created.body.source.includeMedia).toBeUndefined(); // media on by default
    // turn media OFF
    const off = await c.patch(`${KS}/${id}`, { includeMedia: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.source.includeMedia).toBe(false);
    // turn it back ON (field cleared ⇒ default)
    const back = await c.patch(`${KS}/${id}`, { includeMedia: true });
    expect(back.body.source.includeMedia).toBeUndefined();
    // a non-boolean is rejected
    expect((await c.patch(`${KS}/${id}`, { includeMedia: 'yes' })).status).toBe(400);
    // PATCH on an unknown id → 404
    expect((await c.patch(`${KS}/sync:does-not-exist`, { includeMedia: false })).status).toBe(404);
  });

  it('rejects an unparseable folder ref (400) before persisting', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-url-bad');
    const r = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: 'not a real folder link', cadence: 'hourly' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect((await c.get(`${KS}?orgId=${orgId}`)).body.sources).toHaveLength(0); // nothing persisted
  });
});
