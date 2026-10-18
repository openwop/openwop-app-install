/**
 * ADR 0605 Tier 2 — `KSWF-6`: the diff cursor must not outlive its tenant.
 *
 * `SyncFileState` is keyed `<sourceId>:<fileId>`, which carries no tenant, and the
 * row used to carry no `tenantId` field either. `purgeTenantRows` is a CONTENT
 * filtered walk, so `rowTenant` was `undefined` for every one of these rows and the
 * walk skipped them all — while deleting the `SyncSource` that was their ONLY route
 * back to a tenant. The result was a permanent orphan holding the external provider
 * file id, the provider revision, and the KB document id, after an account delete or
 * a DSAR erasure. Witnessed by the assessment as `PROBE-KS-4`.
 *
 * TWO mechanisms, because one does not cover the population:
 *   - NEW rows carry `tenantId`, which `jsonTenantId` (the generic walk's fallback
 *     for a collection with no `tenantOf`) reads. That is the durable fix.
 *   - LEGACY rows have no such field, so a `TENANT_PURGE_HOOKS` pre-hook resolves
 *     them through the parent `SyncSource` — which IS tenant-prefixed — and must run
 *     BEFORE the generic walk deletes that parent.
 * Both lanes are exercised below, and each test targets the lane it names.
 *
 * A NOTE ON HOW THESE TESTS WERE BUILT, because the first draft was VACUOUS. The
 * original "the generic content walk sweeps a stamped row" test used a cursor whose
 * parent source was still alive — so deleting the `tenantId` write left it GREEN,
 * because the pre-hook swept the row anyway. Two mechanisms that overlap make each
 * other's witness unfalsifiable. The tests below therefore use the shapes only ONE
 * mechanism can reach:
 *   - field lane  : a cursor whose parent `SyncSource` no longer exists. The hook
 *                   enumerates sources and finds nothing; only the `tenantId` field
 *                   can save it. This is the actual orphan shape.
 *   - hook lane   : a legacy cursor (no `tenantId`) with a live parent. The content
 *                   walk cannot resolve it at all; only the hook reaches it.
 * Each is sabotage-proved against its OWN mechanism.
 *
 * Sabotage-witnessed (/grade-tests w23): unregistering the purge hook (HOOK LANE red);
 * the generic walk ignoring a collection with no `tenantOf` (FIELD LANE red); the hook
 * scanning every tenant's sources (tenant-scoped case red); a hook that throws on an
 * empty second pass (idempotent red);
 * and the RUNNER no longer stamping `tenantId` on the cursors it writes (the last case —
 * which used to call `upsertFileState` itself and could not see that sabotage).
 * Honest ceiling: the hook's empty-tenant guard is a double guard (see that case).
 */
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The last describe drives the REAL runner: the drive listing/fetch and the KB write are
// the composed seams it calls out to, so those (and only those) are stubbed.
vi.mock('../src/host/knowledgeSourceFetch.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listFolder: vi.fn(async () => ({
    files: [{ fileId: 'f1', name: 'f1', mimeType: 'application/vnd.google-apps.document', revision: 'r1' }],
    complete: true,
  })),
  fetchKnowledgeSource: vi.fn(async () => ({ title: 'f1', text: 'hello' })),
}));
vi.mock('../src/features/kb/kbService.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ingestDocument: vi.fn(async () => ({})),
  deleteDocument: vi.fn(async () => undefined),
}));

import { createApp } from '../src/index.js';
import { hostExtStorage, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';
import { createCollection } from '../src/features/kb/kbService.js';
import {
  createSyncSource, getSyncSource, listFileStates, upsertFileState,
  purgeTenantSyncCursors,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { runKnowledgeSyncOnce } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';

const NOW = '2026-06-22T00:00:00.000Z';
const mk = (tenantId: string) => createSyncSource(
  tenantId, 'org1',
  { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' },
  NOW,
);

let server: http.Server;
beforeAll(async () => {
  // A REAL BOOT, deliberately — `createApp` is what runs `registerRoutes` on every
  // feature, which is where `registerTenantPurgeHook('knowledge-sync', …)` lives.
  //
  // The first draft of this file called `registerTenantPurgeHook` ITSELF and was
  // therefore blind to the wiring: deleting the registration from `feature.ts` left
  // every test GREEN, because the test had supplied the hook the product was
  // supposed to. Mechanism and wiring must be witnessed separately, and the cheapest
  // way to witness the wiring is to let the app do it.
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let seq = 0;
const nextTenant = (): string => `t-ks-purge-${Date.now()}-${(seq += 1)}`;

describe('KSWF-6 — tenant teardown removes the diff cursors', () => {
  it('FIELD LANE: a stamped cursor whose parent source is ALREADY GONE is still swept', async () => {
    // The real orphan shape, and the one only the `tenantId` FIELD can reach: the
    // pre-hook resolves cursors through the tenant's sources, and there is no source
    // here to resolve through. Without the field this row is invisible forever.
    const tenantId = nextTenant();
    const orphanSourceId = 'sync-already-deleted-0000';
    await upsertFileState({
      sourceId: orphanSourceId, externalFileId: 'f1',
      documentId: `sync:${orphanSourceId}:f1`, revision: 'r1', tenantId,
    });
    expect(await listFileStates(orphanSourceId)).toHaveLength(1);

    await purgeTenantHostExt(tenantId);

    expect(await listFileStates(orphanSourceId)).toEqual([]);
  });

  it('HOOK LANE: a LEGACY cursor with NO tenantId is swept via its live parent', async () => {
    const tenantId = nextTenant();
    const s = await mk(tenantId);
    // Exactly the shape written before ADR 0605: no `tenantId` anywhere on the row
    // and none in the key. The generic walk cannot resolve this row at all.
    const legacy = { sourceId: s.id, externalFileId: 'old', documentId: `sync:${s.id}:old`, revision: 'r0' };
    await upsertFileState(legacy);
    expect((await listFileStates(s.id))[0]).not.toHaveProperty('tenantId');

    await purgeTenantHostExt(tenantId);

    expect(await getSyncSource(tenantId, s.id)).toBeNull();
    expect(await listFileStates(s.id)).toEqual([]);
  });

  it('is strictly tenant-scoped — a neighbour tenant keeps every cursor', async () => {
    const mine = nextTenant();
    const theirs = nextTenant();
    const a = await mk(mine);
    const b = await mk(theirs);
    await upsertFileState({ sourceId: a.id, externalFileId: 'f', documentId: `sync:${a.id}:f`, revision: 'r', tenantId: mine });
    await upsertFileState({ sourceId: b.id, externalFileId: 'f', documentId: `sync:${b.id}:f`, revision: 'r', tenantId: theirs });

    await purgeTenantHostExt(mine);

    expect(await listFileStates(a.id)).toEqual([]);
    expect(await listFileStates(b.id)).toHaveLength(1); // untouched
    expect(await getSyncSource(theirs, b.id)).not.toBeNull();
  });

  it('the hook itself fails CLOSED on a falsy tenant — never a global purge', async () => {
    const tenantId = nextTenant();
    const s = await mk(tenantId);
    await upsertFileState({ sourceId: s.id, externalFileId: 'f', documentId: `sync:${s.id}:f`, revision: 'r', tenantId });
    // HONEST CEILING (double guard): the hook's `if (!tenantId) return 0` cannot be
    // witnessed. A falsy tenant scans prefix `:`, which no tenant-prefixed source key
    // matches, so removing the guard leaves this case green (probe
    // `w23g2-tp-hook-failclosed`, vacuous). Seeding an empty-tenant source to make the
    // guard the only thing standing is impossible: `createSyncSource('')` is refused by
    // the workflow-ownership index ("tenantOf produced a non-string/empty tenantId").
    // The case still pins the OUTCOME the guard promises.
    expect(await purgeTenantSyncCursors('')).toBe(0);
    expect(await listFileStates(s.id)).toHaveLength(1); // nothing was swept
  });

  it('is idempotent — a second teardown is a no-op, not an error', async () => {
    const tenantId = nextTenant();
    const s = await mk(tenantId);
    await upsertFileState({ sourceId: s.id, externalFileId: 'f', documentId: `sync:${s.id}:f`, revision: 'r', tenantId });
    await purgeTenantHostExt(tenantId);
    expect(await listFileStates(s.id)).toEqual([]);
    // the second teardown neither throws nor finds anything left to delete
    await expect(purgeTenantHostExt(tenantId)).resolves.toEqual({ deleted: 0, ghostRows: 0, collections: 0 });
  });
});

describe('the runner stamps the tenant, so cursors self-heal as files change', () => {
  // This used to write the cursor with `upsertFileState(..., tenantId)` ITSELF and read it
  // back — a store round-trip that never ran the runner, so removing the runner's stamp
  // left it green (probe `w23g2-tp-runner-stamp`, vacuous). FIELD LANE above also supplies
  // the field by hand, so before this case nothing witnessed that the RUNNER writes it.
  it('the RUNNER stamps tenantId on every cursor it writes', async () => {
    const tenantId = `org:ks-purge-runner-${Date.now()}-${(seq += 1)}`;
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: 'org1', userId: 'user:o',
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    await createCollection(tenantId, 'org1', 'test', { name: 'col' }, { collectionId: 'col' });
    const s = await createSyncSource(tenantId, 'org1', {
      connectionId: conn.connectionId, provider: 'google', externalFolderId: 'F',
      collectionId: 'col', cadence: 'hourly', createdBy: 'user:o',
    }, NOW);

    const result = await runKnowledgeSyncOnce({ storage: hostExtStorage() }, s);

    expect(result).toMatchObject({ ingested: 1, failed: 0, errors: [] });
    const cursors = await listFileStates(s.id);
    expect(cursors.map((c) => c.externalFileId)).toEqual(['f1']);
    expect(cursors[0]?.tenantId, 'a cursor without its tenant is invisible to teardown once its source is gone').toBe(tenantId);
  });
});
