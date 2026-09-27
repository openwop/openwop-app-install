/**
 * ADR 0107 Phase 3b — the cadence daemon. Covers isSyncDue (cadence/paused logic),
 * the per-source claimOnce dedup (multi-instance / daemon-vs-manual safety),
 * and processDueSyncs (runs due sources once, skips claimed ones).
 *
 * WF-KB-4 / ADR 0583 — the RECURRING lane now honours the feature toggle, the
 * way all eight routes always did. Note what that means for this file: every
 * pre-existing `processDueSyncs` assertion below needed the toggle turned ON to
 * keep passing. That is the finding, restated as a fact about the tests: they
 * had been exercising a daemon that spent a DISABLED tenant's egress and
 * embedding budget, and nothing in them could tell.
 */

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { knowledgeSyncFeature } from '../src/features/knowledge-sync/feature.js';

/** Flipped by the fail-closed test to make the toggle resolver throw. */
const toggleFault = vi.hoisted(() => ({ on: false }));
vi.mock('../src/host/featureToggles/service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/host/featureToggles/service.js')>(
    '../src/host/featureToggles/service.js',
  );
  return {
    ...actual,
    resolveOne: (...args: Parameters<typeof actual.resolveOne>) =>
      toggleFault.on ? Promise.reject(new Error('toggle store unavailable')) : actual.resolveOne(...args),
  };
});

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
// WF-KB-3 / KSWF-1 — the bespoke daemon (processDueSyncs / startKnowledgeSyncDaemon /
// knowledgeSyncKillSwitchEngaged) is DELETED; its dispatch behaviour (per-tenant
// spend gate + entitlement + skip) moved to the `knowledge-sync` surface and is
// covered in knowledge-sync-workflow.test.ts. These are the surviving pure/hygiene
// helpers, now in the service.
import {
  isSyncDue, claimSyncRun, pruneStaleKnowledgeSyncClaims, SYNC_LEASE_MS,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';

const mockedSyncNow = vi.mocked(syncNow);
const mockedList = vi.mocked(listActiveSyncSourcesForTenant);

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // WF-KB-3 — `createSyncSource` now registers the source's `knowledge-sync.run`
  // workflow + scheduler job, so the chain pack must be loaded (the examples/ pack
  // resolves via the in-tree fallback; the full-app tests get it from createApp).
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  // `knowledge-sync` ships `status:'off'`. The daemon now honours that per
  // tenant, so the cadence assertions below run against an ENABLED host. The
  // default comes from the feature module (the SSoT) rather than a hand-written
  // copy — this file boots no app, so nothing else registers it.
  const cfg = knowledgeSyncFeature.toggleDefault;
  expect(cfg, 'knowledge-sync must declare a toggle default').toBeTruthy();
  registerToggleDefault(cfg!);
  await saveConfig({ ...cfg!, status: 'on' }, 'test');
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

  /**
   * ADR 0605 R1 (review HIGH 1) — the racer suppression the pre-run lease needs.
   *
   * The lease rotates the claim key mid-pass, which is what makes a crash
   * recoverable — and would, on its own, let the very next tick win a fresh claim
   * over a pass that is still running. `scheduleDaemon` gets this suppression
   * from the `nextFireAt` it advanced before dispatch; here it is the lease. A
   * cure that reintroduced the double-run it replaced would be the family this
   * whole fold-in is about.
   */
  it('a pass IN FLIGHT is not due, and becomes due again once the lease lapses', () => {
    const started = new Date(now - 60_000).toISOString();
    expect(isSyncDue(src({ syncStartedAt: started }), now)).toBe(false);
    expect(isSyncDue(src({ syncStartedAt: started }), now + SYNC_LEASE_MS)).toBe(true);
    // A corrupt stamp must never be able to become the permanent wedge the lease
    // exists to remove — it reads as "no pass in flight".
    expect(isSyncDue(src({ syncStartedAt: 'not-a-date' }), now)).toBe(true);
  });
});

/**
 * ADR 0605 R1 (review HIGH 1, the belt) — this daemon self-prunes its own claim
 * prefix, like the other three that use the mutex. Before, the only backstop was
 * the GLOBAL retention sweep, which is a no-op whenever an operator sets
 * `OPENWOP_IDEMPOTENCY_TTL_DAYS=0` — so a host could be configured such that
 * nothing ever freed these rows.
 */
describe('pruneStaleKnowledgeSyncClaims (`KSWF-15`)', () => {
  it('deletes only OLD knowledge-sync claim rows, and leaves other daemons alone', async () => {
    const old = new Date(1_600_000_000_000).toISOString();
    const fresh = new Date(1_900_000_000_000).toISOString();
    await storage.claimOnce('knowledge-sync:t1:prune-me:v0', old);
    await storage.claimOnce('knowledge-sync:t1:keep-me:v0', fresh);
    await storage.claimOnce('schedule-fire:someone-elses:0', old);

    const pruned = await pruneStaleKnowledgeSyncClaims({ storage }, 1_900_000_000_000);
    expect(pruned).toBeGreaterThanOrEqual(1);
    // the OLD one is gone (its key is claimable again)…
    expect((await storage.claimOnce('knowledge-sync:t1:prune-me:v0', fresh)).claimed).toBe(true);
    // …the fresh one is NOT (a live pass must never have its claim pulled)…
    expect((await storage.claimOnce('knowledge-sync:t1:keep-me:v0', fresh)).claimed).toBe(false);
    // …and another daemon's prefix is untouched.
    expect((await storage.claimOnce('schedule-fire:someone-elses:0', fresh)).claimed).toBe(false);
  });

  it('targets ONLY the knowledge-sync claim prefix (the surface runs it per fire)', async () => {
    // WF-KB-3 — the prune used to run per daemon tick; it now runs once per scheduled
    // `runOnce` in the surface. The mechanism (prefix-scoped prune) is unchanged.
    const spy = vi.spyOn(storage, 'pruneOnceByPrefix');
    await pruneStaleKnowledgeSyncClaims({ storage }, 1_900_000_400_000);
    expect(spy).toHaveBeenCalledWith('knowledge-sync:', expect.any(String));
    spy.mockRestore();
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
