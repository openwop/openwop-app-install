/**
 * ADR 0107 Phase 3b — the cadence daemon. Covers isSyncDue (cadence/paused logic),
 * the per-source claimIdempotency dedup (multi-instance / daemon-vs-manual safety),
 * and processDueSyncs (runs due sources once, skips claimed ones).
 */

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

vi.mock('../src/features/knowledge-sync/knowledgeSyncRunner.js', () => ({
  syncNow: vi.fn(async () => ({ added: 0, updated: 0, removed: 0, skipped: 0 })),
}));
vi.mock('../src/features/knowledge-sync/knowledgeSyncService.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/knowledge-sync/knowledgeSyncService.js')>(
    '../src/features/knowledge-sync/knowledgeSyncService.js',
  );
  return { ...actual, listActiveSyncSourcesForTenant: vi.fn() };
});

import { syncNow } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';
import { listActiveSyncSourcesForTenant, createSyncSource, listSyncSourceTenants } from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { isSyncDue, claimSyncRun, processDueSyncs } from '../src/features/knowledge-sync/knowledgeSyncDaemon.js';

const mockedSyncNow = vi.mocked(syncNow);
const mockedList = vi.mocked(listActiveSyncSourcesForTenant);

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
beforeEach(() => { mockedSyncNow.mockClear(); mockedList.mockReset(); });

const src = (over: Record<string, unknown> = {}) => ({
  id: 'src1', tenantId: 't1', orgId: 'o1', connectionId: 'c', provider: 'google',
  externalFolderId: 'F', collectionId: 'col', cadence: 'hourly', status: 'active', ...over,
}) as never;

describe('isSyncDue', () => {
  const now = 1_700_000_000_000;
  it('due when never synced; not due within interval; due after', () => {
    expect(isSyncDue(src(), now)).toBe(true);
    expect(isSyncDue(src({ lastSyncedAt: new Date(now - 60_000).toISOString() }), now)).toBe(false);
    expect(isSyncDue(src({ lastSyncedAt: new Date(now - 2 * 3_600_000).toISOString() }), now)).toBe(true);
  });
  it('never due when paused', () => {
    expect(isSyncDue(src({ status: 'paused' }), now)).toBe(false);
  });
});

describe('claimSyncRun', () => {
  it('wins once per source per slot, releases next slot', async () => {
    const t = 1_700_000_000_000;
    expect(await claimSyncRun(storage, 't1', 'c1', t)).toBe(true);
    expect(await claimSyncRun(storage, 't1', 'c1', t + 1000)).toBe(false);
    expect(await claimSyncRun(storage, 't1', 'c1', t + 11 * 60 * 1000)).toBe(true);
  });
});

describe('processDueSyncs', () => {
  it('runs each due source once via syncNow; a claimed source is skipped', async () => {
    const now = 1_800_000_000_000;
    mockedList.mockResolvedValue([src({ id: 'a' }), src({ id: 'b', lastSyncedAt: new Date(now - 60_000).toISOString() })]); // a due, b not
    const ran = await processDueSyncs({ storage }, async () => ['t1'], now);
    expect(ran).toBe(1); // only 'a' was due
    expect(mockedSyncNow).toHaveBeenCalledTimes(1);
    // A second pass in the SAME slot re-lists 'a' as due but the claim is held → skipped.
    mockedSyncNow.mockClear();
    const ran2 = await processDueSyncs({ storage }, async () => ['t1'], now);
    expect(ran2).toBe(0);
    expect(mockedSyncNow).not.toHaveBeenCalled();
  });
});

describe('listSyncSourceTenants — daemon enumerator covers ALL tenants with sources', () => {
  it('returns the distinct tenant set by sync-source presence (not roster presence)', async () => {
    // The daemon's coverage must NOT be coupled to roster presence: a tenant can
    // sync its KB with no agents. Seed sources for two roster-less tenants.
    await createSyncSource('tenant-noroster-1', 'o', { connectionId: 'c', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, new Date(0).toISOString());
    await createSyncSource('tenant-noroster-1', 'o2', { connectionId: 'c', provider: 'google', externalFolderId: 'F2', collectionId: 'col', cadence: 'daily' }, new Date(0).toISOString());
    await createSyncSource('tenant-noroster-2', 'o', { connectionId: 'c', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, new Date(0).toISOString());
    const tenants = await listSyncSourceTenants();
    expect(tenants).toContain('tenant-noroster-1');
    expect(tenants).toContain('tenant-noroster-2');
    // distinct — the two sources under tenant-noroster-1 collapse to one entry
    expect(tenants.filter((t) => t === 'tenant-noroster-1')).toHaveLength(1);
  });
});
