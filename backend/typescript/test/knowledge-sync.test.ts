/**
 * ADR 0107 Phase 2 — the knowledge-sync feature-package (config layer). Two parts:
 *  (a) the service CRUD + diff-state store (createSyncSource validation, org-filtered
 *      list, cross-tenant null, status, delete-cascades-file-state);
 *  (b) the routes' gating — toggle 404 (ADR 0681 D1: every route, by message), missing-org
 *      400, non-existent-connection 404, cross-tenant IDOR 404 (and the victim row
 *      survives). The 201 happy-path seeds a Google OAuth connection (built-in `google`
 *      provider) + a KB collection, incl. the folder-URL→id normalization (ADR 0107
 *      follow-on) and the ADR 0108 OQ-3 `includeMedia` opt-out.
 *
 * Sabotage-witnessed (/grade-tests w23): inverting the diff's revision compare, the prune
 * filter or the malformed-entry skip; dropping the org filter, the provider/cadence
 * validation, the delete cascade, the status write; removing `requireFeatureEnabled`
 * from a route; an unlisted new route; a tenant-blind source lookup; the route's own
 * folder-URL refusal (asserted by its MESSAGE — the service's `req()` also answers 400).
 *
 * Honest double guard: `getSyncSource`'s `s.tenantId === tenantId` belt cannot be
 * witnessed — the store key is `<tenantId>:<id>`, so a cross-tenant read misses before
 * the belt runs (probe `w23g2-ks-svc-crosstenant-belt`, vacuous). The tenant-blind lookup
 * probe is the witness instead.
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
  type RemoteFile, type SyncFileState, type SyncSource,
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
    const remote = [rf('a', 'r1'), rf('b', 'r2-NEW'), rf('c', 'r3')]; // a unchanged, b changed, c new
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

    await setSyncStatus('tA', s.id, 'paused', NOW, { pausedReason: 'user' });
    // read back — the PERSISTED row, not the writer's return value
    expect((await getSyncSource('tA', s.id))?.status).toBe('paused');
    expect((await getSyncSource('tA', s.id))?.pausedReason).toBe('user');
    await setSyncStatus('tA', s.id, 'active', NOW, { pausedReason: null });
    const resumed = await getSyncSource('tA', s.id);
    expect(resumed?.status).toBe('active');
    expect(resumed?.pausedReason).toBeUndefined(); // a resumed row cannot keep a pause reason

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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The response bodies this file reads — typed, not `any`, so a misspelled field is a tsc error. */
interface KsBody {
  error?: string;
  message?: string;
  orgId?: string;
  source?: SyncSource;
  sources?: SyncSource[];
  deleted?: boolean;
}
interface Res { status: number; body: KsBody | undefined }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as KsBody | undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const uniqEmail = (who: string) => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string) {
  const c = client();
  await c.post('/host/openwop-app/test/login', { email: uniqEmail(who) });
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: String(org.body?.orgId) };
}
const KS = '/host/openwop-app/knowledge-sync';

async function enableToggle(on: boolean) {
  const d = getToggleDefault('knowledge-sync');
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

describe('knowledge-sync routes — gating (ADR 0107 Phase 2)', () => {
  beforeEach(() => enableToggle(true));

  /**
   * ADR 0681 D1 — this test's NAME asserts the whole route population; its body used to walk
   * TWO of eight (`GET /` and `POST /`). Measuring every request made inside an
   * `enableToggle(false)` window across the whole file, feature-wide coverage was 3 of 8
   * (`/browse` is covered by the next test) — so FIVE routes had no toggle-gate coverage, four
   * of them mutating or destructive: `DELETE /:id`, `POST /:id/{pause,resume}`, `PATCH /:id`,
   * and `POST /:id/sync`, which triggers a real sync pass and its spend.
   *
   * The table is now the assertion. A route added to `routes.ts` without a row here fails the
   * count leg below rather than silently shrinking the proportion the name claims.
   */
  // The call must be typed by what the client ACTUALLY returns — the leg below reads
  // `res.body.message` to tell a toggle-off 404 from a not-found 404, and a hand-written
  // `{ status: number }` made that a type error. (Shipped red in ADR 0681: I typechecked
  // BEFORE adding that assertion and never re-ran it; vitest passes because it does not
  // typecheck. Derive the type instead of restating it.)
  type RouteCall = (c: ReturnType<typeof client>, orgId: string) => Promise<Awaited<ReturnType<ReturnType<typeof client>['get']>>>;
  const TOGGLE_GATED_ROUTES: ReadonlyArray<{ label: string; call: RouteCall }> = [
    { label: 'POST   /',                 call: (c, orgId) => c.post(KS, { orgId }) },
    { label: 'GET    /',                 call: (c, orgId) => c.get(`${KS}?orgId=${orgId}`) },
    { label: 'GET    /browse',           call: (c, orgId) => c.get(`${KS}/browse?orgId=${orgId}&connectionId=c`) },
    { label: 'GET    /:id',              call: (c, orgId) => c.get(`${KS}/ks-1?orgId=${orgId}`) },
    { label: 'DELETE /:id',              call: (c, orgId) => c.del(`${KS}/ks-1?orgId=${orgId}`) },
    { label: 'POST   /:id/pause',        call: (c, orgId) => c.post(`${KS}/ks-1/pause`, { orgId }) },
    { label: 'POST   /:id/resume',       call: (c, orgId) => c.post(`${KS}/ks-1/resume`, { orgId }) },
    { label: 'PATCH  /:id',              call: (c, orgId) => c.patch(`${KS}/ks-1`, { orgId, cadence: 'daily' }) },
    { label: 'POST   /:id/sync',         call: (c, orgId) => c.post(`${KS}/ks-1/sync`, { orgId }) },
  ];

  it('404s EVERY route while the toggle is OFF — all of them, not the two the name used to cover', async () => {
    await enableToggle(false);
    try {
      const { c, orgId } = await ownerWithOrg('ks-off');
      for (const { label, call } of TOGGLE_GATED_ROUTES) {
        const res = await call(c, orgId);
        expect(res.status, `${label} must 404 while the toggle is OFF`).toBe(404);
        // NON-VACUITY (this leg was vacuous when first written, and a sabotage caught it):
        // asserting 404 alone cannot tell "404 because the toggle is off" from "404 because
        // `ks-1` does not exist" — removing `requireFeatureEnabled` from POST /:id/sync left the
        // whole file GREEN. Both paths throw `not_found`, so the status and the code are both
        // useless here; what separates them is the toggle-off message, which names the feature
        // (`featureRoute.ts:41` — "<label> is not enabled for this tenant.").
        expect(
          String(res.body?.message ?? ''),
          `${label} must 404 because the TOGGLE is off, not because the resource is missing`,
        ).toMatch(/is not enabled for this tenant/i);
      }
    } finally { await enableToggle(true); } // restore — never leak a global toggle into a later case
  });

  it('the table above covers every route the feature registers — a new route cannot shrink the claim silently', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/features/knowledge-sync/routes.ts', import.meta.url), 'utf8');
    // `POST /:id/:action` is registered in a `for (const action of ['pause','resume'])` loop, so
    // the source shows ONE registration for TWO routes; the table lists both.
    const registrations = [...src.matchAll(/^\s*app\.(get|post|put|patch|delete)\(/gm)].length;
    expect(registrations, 'app.<verb>( registrations in routes.ts').toBe(8);
    expect(TOGGLE_GATED_ROUTES.length, 'the table expands the pause/resume loop into its two routes').toBe(registrations + 1);
    // Honest limit (ADR 0681 Open Question): this reads the registrations out of the SOURCE
    // TEXT, not a runtime route table — weaker than enumerating the router, and stated rather
    // than hidden. It still fails on an unlisted new route, which is what it is for.
  });

  it('rejects a create with no orgId (400) and a non-existent connection (404)', async () => {
    const { c, orgId } = await ownerWithOrg('ks-val');
    const noOrg = await c.post(KS, {});
    expect(noOrg.status).toBe(400); // no orgId
    expect(noOrg.body?.error).toBe('validation_error');
    expect(noOrg.body?.message).toMatch(/orgId/);
    const r = await c.post(KS, { orgId, connectionId: 'conn:does-not-exist', collectionId: 'col', provider: 'google', externalFolderId: 'F', cadence: 'hourly' });
    expect(r.status, JSON.stringify(r.body)).toBe(404); // connection not found
    expect(r.body?.error).toBe('not_found');
    // the CONNECTION guard answered, not the (also missing) collection lookup behind it
    expect(r.body?.message).toMatch(/Connection not found/);
  });

  // The toggle-off leg that used to open this case was a status-only duplicate of the
  // `GET /browse` row of the table above (which also checks the toggle-off MESSAGE). Probe
  // `w23g2-ks-rt-toggle-browse` (gate removed from /browse) left this leg GREEN — the 404
  // came from the unknown connection — and turned only the table case red. Cut, not lost.
  it('GET /browse — requires orgId, 404 on an unknown connection', async () => {
    const { c, orgId } = await ownerWithOrg('ks-browse');
    const noOrg = await c.get(`${KS}/browse?connectionId=c`);
    expect(noOrg.status).toBe(400); // no orgId
    expect(noOrg.body?.message).toMatch(/orgId/);
    const unknown = await c.get(`${KS}/browse?orgId=${orgId}&connectionId=conn:nope`);
    expect(unknown.status).toBe(404); // unknown connection
    expect(unknown.body?.message).toMatch(/Connection not found/);
  });

  it('cross-tenant IDOR: a stranger gets a uniform 404 for another tenant\'s source', async () => {
    const { c: stranger } = await ownerWithOrg('ks-stranger');
    // seed a source for an unrelated tenant directly via the service
    const seeded = await createSyncSource('tenant-victim', 'org-v', { connectionId: 'c', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    const read = await stranger.get(`${KS}/${seeded.id}`);
    expect(read.status).toBe(404);
    expect(read.body?.message).toMatch(/Sync source not found/); // the uniform not-found, not a 403 that leaks existence
    const del = await stranger.del(`${KS}/${seeded.id}`);
    expect(del.status).toBe(404);
    expect(del.body?.message).toMatch(/Sync source not found/);
    expect(await getSyncSource('tenant-victim', seeded.id), 'the victim\'s source must survive the stranger\'s DELETE').not.toBeNull();
  });
});

describe('create normalizes a Google Drive folder URL (ADR 0107 follow-on)', () => {
  beforeEach(() => enableToggle(true));
  const FOLDER_ID = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

  async function seededOrg(who: string): Promise<{ c: ReturnType<typeof client>; orgId: string; connectionId: string; collectionId: string }> {
    const tenantId = `org:${who}-${Date.now()}-${n++}`;
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
    const orgId = String((await c.post('/host/openwop-app/orgs', { name: 'Acme' })).body?.orgId);
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
    expect(r.body?.source?.externalFolderId).toBe(FOLDER_ID); // URL normalized server-side
  });

  it('persists the per-source includeMedia opt-out through the route (ADR 0108 OQ-3)', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-media');
    // explicit opt-out → stored false on the source
    const off = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: FOLDER_ID, cadence: 'hourly', includeMedia: false });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(off.body?.source?.includeMedia).toBe(false);
    // omitted ⇒ media included (the field is simply absent; the runner treats absent as true)
    const on = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: FOLDER_ID, cadence: 'daily' });
    expect(on.status, JSON.stringify(on.body)).toBe(201);
    expect(on.body?.source?.includeMedia).toBeUndefined();
  });

  it('PATCH /:id toggles includeMedia on an existing source without recreate (ADR 0108 OQ-3 follow-on)', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-patch');
    const created = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: FOLDER_ID, cadence: 'daily' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body?.source?.id);
    expect(created.body?.source?.includeMedia).toBeUndefined(); // media on by default
    // turn media OFF
    const off = await c.patch(`${KS}/${id}`, { includeMedia: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body?.source?.includeMedia).toBe(false);
    // turn it back ON (field cleared ⇒ default)
    const back = await c.patch(`${KS}/${id}`, { includeMedia: true });
    expect(back.status).toBe(200);
    expect(back.body?.source?.includeMedia).toBeUndefined();
    // a non-boolean is rejected
    expect((await c.patch(`${KS}/${id}`, { includeMedia: 'yes' })).status).toBe(400);
    // PATCH on an unknown id → 404
    expect((await c.patch(`${KS}/sync:does-not-exist`, { includeMedia: false })).status).toBe(404);
  });

  it('rejects an unparseable folder ref (400) before persisting', async () => {
    const { c, orgId, connectionId, collectionId } = await seededOrg('ks-url-bad');
    const r = await c.post(KS, { orgId, connectionId, collectionId, provider: 'google', externalFolderId: 'not a real folder link', cadence: 'hourly' });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe('validation_error');
    // The ROUTE's refusal, by its message: with it removed, the service's `req()` ALSO
    // answers 400 validation_error ("`externalFolderId` is required") and persists
    // nothing, so status + code + empty list were all green under that sabotage
    // (probe `w23g2-ks-rt-url-reject`, vacuous before this line).
    expect(r.body?.message).toMatch(/Google Drive folder link/i);
    expect((await c.get(`${KS}?orgId=${orgId}`)).body?.sources).toHaveLength(0); // nothing persisted
  });
});
