/**
 * The knowledge-sync single-runner + hygiene helpers that SURVIVED the daemon
 * deletion (WF-KB-3 / KSWF-1 deleted `knowledgeSyncDaemon.ts`; the recurring pass is a
 * scheduler-fired `knowledge-sync.run` workflow, witnessed in
 * `knowledge-sync-workflow.test.ts`). The file keeps its historical name because ADRs
 * cite it; everything it tests lives in `knowledgeSyncService.ts` and is called by a
 * live lane:
 *
 *  - `syncLeaseHeld` (ADR 0605 R1, review HIGH 1) — `syncNow`'s in-flight 409. A crashed
 *    pass's lease must EXPIRE (bounded wedge), never be permanent. Red if the lease
 *    window comparison is broken.
 *  - `pruneStaleKnowledgeSyncClaims` (`KSWF-15`) — run by the surface on every fire;
 *    deletes only OLD rows under its OWN prefix. Red if the age cutoff or the prefix is
 *    wrong.
 *  - `claimSyncRun` (ADR 0605 `KSWF-5`) — the claim key is DATA-derived (`updatedAt` +
 *    pass fields), never wall-clock, and scoped per tenant + source. Red if `updatedAt`
 *    drops out of the key, a wall-clock slot is folded back in, or the tenant is dropped.
 *  - `listSyncSourceTenants` — the boot backfill's tenant enumerator: distinct tenants by
 *    sync-source presence. Red if it stops de-duplicating.
 *
 * CORRECTED 2026-10-11 (grade-tests w23): this header used to describe `processDueSyncs`
 * and the cadence daemon, and the file still carried that daemon's scaffolding (a runner
 * mock, a toggle-ON setup, and a `toggleFault` resolver mock nothing flipped any more —
 * the fail-closed case it served was deleted with the daemon). Of the three `isSyncDue`
 * cases, two were removed and one rewritten: `isSyncDue` has no product caller since WF-KB-3 (the per-source cron owns
 * cadence; the paused/backoff gates are the scheduler job + the surface, witnessed in
 * `knowledge-sync-runner.test.ts` / `knowledge-sync-workflow.test.ts`). The in-flight
 * case moved to `syncLeaseHeld`, the predicate `syncNow` actually calls. The fail-closed
 * resolver witness now lives in `knowledge-sync-workflow.test.ts`.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';
import {
  createSyncSource, listSyncSourceTenants,
  syncLeaseHeld, claimSyncRun, pruneStaleKnowledgeSyncClaims, SYNC_LEASE_MS,
  type SyncSource,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // `createSyncSource` registers the source's `knowledge-sync.run` workflow + scheduler
  // job, so the chain pack must be loaded (the examples/ pack resolves in-tree).
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
});

const src = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: 'src1', tenantId: 't1', orgId: 'o1', connectionId: 'c', provider: 'google',
  externalFolderId: 'F', collectionId: 'col', cadence: 'hourly', status: 'active',
  createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z', ...over,
});

describe('syncLeaseHeld — the in-flight lease is BOUNDED (ADR 0605 R1)', () => {
  const now = 1_700_000_000_000;
  /**
   * The lease rotates the claim key mid-pass, which is what makes a crash recoverable —
   * and `syncNow` refuses a second pass while it is held. A lease that never lapsed
   * would be the permanent wedge R1 removed; one that never held would re-admit the
   * double run.
   */
  it('a pass IN FLIGHT holds the lease, and releases it once the lease lapses', () => {
    const started = new Date(now - 60_000).toISOString();
    expect(syncLeaseHeld(src({ syncStartedAt: started }), now)).toBe(true);
    expect(syncLeaseHeld(src({ syncStartedAt: started }), now - 60_000 + SYNC_LEASE_MS - 1)).toBe(true);
    expect(syncLeaseHeld(src({ syncStartedAt: started }), now - 60_000 + SYNC_LEASE_MS)).toBe(false);
    expect(syncLeaseHeld(src(), now)).toBe(false); // no stamp, no lease
    // A corrupt stamp must never become the permanent wedge the lease exists to remove.
    // HONEST CEILING (probe w23g1-dm-lease-nan-guard, vacuous): this holds by NaN
    // arithmetic (`now - NaN < X` is false) even without the `Number.isFinite` guard, so
    // it witnesses the OUTCOME, not that guard.
    expect(syncLeaseHeld(src({ syncStartedAt: 'not-a-date' }), now)).toBe(false);
  });
});

/**
 * ADR 0605 R1 (review HIGH 1, the belt) — this feature self-prunes its own claim prefix.
 * The only other backstop is the GLOBAL retention sweep, a no-op whenever an operator
 * sets `OPENWOP_IDEMPOTENCY_TTL_DAYS=0`.
 */
describe('pruneStaleKnowledgeSyncClaims (`KSWF-15`)', () => {
  it('deletes only OLD knowledge-sync claim rows, and leaves other daemons alone', async () => {
    // A storage of its own, so the count is exact and no other case's rows are in play.
    const own = await openStorage('memory://');
    const old = new Date(1_600_000_000_000).toISOString();
    const fresh = new Date(1_900_000_000_000).toISOString();
    await own.claimOnce('knowledge-sync:t1:prune-me:v0', old);
    await own.claimOnce('knowledge-sync:t1:keep-me:v0', fresh);
    await own.claimOnce('schedule-fire:someone-elses:0', old);

    const pruned = await pruneStaleKnowledgeSyncClaims({ storage: own }, 1_900_000_000_000);
    expect(pruned).toBe(1);
    // the OLD one is gone (its key is claimable again)…
    expect((await own.claimOnce('knowledge-sync:t1:prune-me:v0', fresh)).claimed).toBe(true);
    // …the fresh one is NOT (a live pass must never have its claim pulled)…
    expect((await own.claimOnce('knowledge-sync:t1:keep-me:v0', fresh)).claimed).toBe(false);
    // …and another daemon's prefix is untouched (this is the prefix-scoping witness).
    expect((await own.claimOnce('schedule-fire:someone-elses:0', fresh)).claimed).toBe(false);
  });
});

describe('claimSyncRun — DATA-DERIVED, not wall-clock (ADR 0605 `KSWF-5`)', () => {
  it('wins once per source STATE; a later state is claimable again', async () => {
    const t = 1_700_000_000_000;
    const s1 = src({ id: 'c1', updatedAt: '2026-06-22T00:00:00.000Z' });
    expect(await claimSyncRun(storage, 't1', s1, t)).toBe(true);
    expect(await claimSyncRun(storage, 't1', s1, t + 1000)).toBe(false);
    // the pass completed and bumped `updatedAt` ⇒ the next pass may claim
    const s2 = src({ id: 'c1', updatedAt: '2026-06-22T01:00:00.000Z' });
    expect(await claimSyncRun(storage, 't1', s2, t + 1000)).toBe(true);
  });

  it('NO WALL-CLOCK BOUNDARY: two ticks 200ms apart across the old slot edge cannot both win', async () => {
    // The `KSWF-5` measurement, inverted into a guarantee. With the old
    // `Math.floor(now / 10min)` key these two calls computed DIFFERENT keys and
    // BOTH returned true, double-running one source against one diff cursor.
    const SLOT = 10 * 60 * 1000;
    const edge = Math.ceil(1_700_000_000_000 / SLOT) * SLOT;
    const s = src({ id: 'c-edge', updatedAt: '2026-06-22T00:00:00.000Z' });
    expect(await claimSyncRun(storage, 't1', s, edge - 100)).toBe(true);
    expect(await claimSyncRun(storage, 't1', s, edge + 100)).toBe(false);
  });

  it('is scoped per tenant AND per source', async () => {
    const t = 1_700_000_000_000;
    const s = src({ id: 'shared-id', updatedAt: '2026-06-22T00:00:00.000Z' });
    expect(await claimSyncRun(storage, 'tenant-a', s, t)).toBe(true);
    expect(await claimSyncRun(storage, 'tenant-b', s, t)).toBe(true); // different tenant
    expect(await claimSyncRun(storage, 'tenant-a', src({ id: 'other-id', updatedAt: '2026-06-22T00:00:00.000Z' }), t)).toBe(true);
  });
});


describe('listSyncSourceTenants — the boot-backfill enumerator covers ALL tenants with sources', () => {
  it('returns the distinct tenant set by sync-source presence (not roster presence)', async () => {
    // Coverage must NOT be coupled to roster presence: a tenant can sync its KB with
    // no agents. Seed sources for two roster-less tenants.
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
