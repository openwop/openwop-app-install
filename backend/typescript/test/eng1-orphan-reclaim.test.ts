/**
 * ENG-1 — multi-instance run-dispatch crash recovery (orphan reclaim).
 *
 * Pins the claim contract that `runDispatchSweeper` relies on
 * (`storage.claimOrphanedRuns` + `storage.setRunDispatchLease`) and the
 * sweeper's own decision logic:
 *
 *   - A `pending`/`running` run whose dispatch lease has EXPIRED (or is
 *     absent) and is older than the grace window is claimed EXACTLY ONCE —
 *     two workers racing the same orphan see only one of them win it.
 *   - A FRESH run (inside the grace window) is NOT reclaimed.
 *   - A LEASED run (lease not yet expired) is NOT reclaimed.
 *   - A TERMINAL run (completed/failed/cancelled) is NOT reclaimed.
 *   - The claim stamps a fresh lease (owner + future expiry) on the winner.
 *
 * Everything runs against the in-memory sqlite Storage (`memory://`), the
 * same backend the multi-instance code paths use; the claim is required to
 * be multi-instance-safe (single write txn on sqlite), so the once-only
 * guarantee is observable here.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { sweepOrphanedRuns, type RunSweeperDeps } from '../src/host/runDispatchSweeper.js';
import { RUN_DISPATCH_LEASE_MS } from '../src/executor/executor.js';
import { createHostAdapterSuite } from '../src/host/index.js';

let storage: Storage;

/** Mirror of the sweeper's internal grace window (runs younger than this are
 *  never swept). Kept in sync with runDispatchSweeper.GRACE_MS. */
const GRACE_MS = 120_000;
/** Mirror of MAX_REDISPATCH_AGE_MS — older orphans are abandoned, not re-run. */
const MAX_REDISPATCH_AGE_MS = 3_600_000;

beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
});

let seq = 0;
async function seedRun(over: Partial<RunRecord> = {}): Promise<RunRecord> {
  const nowIso = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-orphan-${++seq}`,
    workflowId: 'wf.orphan',
    tenantId: 'demo',
    status: 'running',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: nowIso,
    updatedAt: nowIso,
    ...over,
  };
  await storage.insertRun(run);
  return run;
}

describe('ENG-1 storage.claimOrphanedRuns — atomic orphan reclaim', () => {
  it('claims an expired-lease orphan EXACTLY ONCE across two racing workers', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 10 * 60_000).toISOString(); // 10m old > grace
    const orphan = await seedRun({ createdAt: oldIso, updatedAt: oldIso });
    // Stamp an ALREADY-EXPIRED lease (some crashed instance's leftover).
    await storage.setRunDispatchLease(orphan.runId, 'instance-crashed', now - 1_000);

    const staleBefore = new Date(now - GRACE_MS).toISOString();
    const [a, b] = await Promise.all([
      storage.claimOrphanedRuns('worker-A', now, staleBefore, RUN_DISPATCH_LEASE_MS, 10),
      storage.claimOrphanedRuns('worker-B', now, staleBefore, RUN_DISPATCH_LEASE_MS, 10),
    ]);

    const claimedIds = [...a, ...b].map((r) => r.runId);
    expect(claimedIds.filter((id) => id === orphan.runId)).toHaveLength(1);

    // The winner stamped a FRESH lease (owner is one of the two workers, expiry in the future).
    const after = (await storage.getRun(orphan.runId))!;
    expect(['worker-A', 'worker-B']).toContain(after.dispatchOwner);
    expect(after.dispatchLeaseExpiresAt!).toBeGreaterThan(now);
  });

  it('claims a run with NO lease at all (lease absent ⇒ orphaned)', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 10 * 60_000).toISOString();
    const orphan = await seedRun({ createdAt: oldIso, updatedAt: oldIso, status: 'pending' });

    const claimed = await storage.claimOrphanedRuns(
      'worker-A',
      now,
      new Date(now - GRACE_MS).toISOString(),
      RUN_DISPATCH_LEASE_MS,
      10,
    );
    expect(claimed.map((r) => r.runId)).toContain(orphan.runId);
  });

  it('does NOT reclaim a FRESH run (inside the grace window)', async () => {
    const now = Date.now();
    // createdAt is now ⇒ younger than GRACE_MS ⇒ excluded by staleBefore.
    const fresh = await seedRun({ status: 'pending' });

    const claimed = await storage.claimOrphanedRuns(
      'worker-A',
      now,
      new Date(now - GRACE_MS).toISOString(),
      RUN_DISPATCH_LEASE_MS,
      10,
    );
    expect(claimed.map((r) => r.runId)).not.toContain(fresh.runId);
  });

  it('does NOT reclaim a run whose lease is still VALID (owning instance alive)', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 10 * 60_000).toISOString();
    const leased = await seedRun({ createdAt: oldIso, updatedAt: oldIso });
    // Lease expires in the future ⇒ owner presumed alive ⇒ not an orphan.
    await storage.setRunDispatchLease(leased.runId, 'instance-alive', now + RUN_DISPATCH_LEASE_MS);

    const claimed = await storage.claimOrphanedRuns(
      'worker-A',
      now,
      new Date(now - GRACE_MS).toISOString(),
      RUN_DISPATCH_LEASE_MS,
      10,
    );
    expect(claimed.map((r) => r.runId)).not.toContain(leased.runId);
    // The original owner/lease is untouched.
    const after = (await storage.getRun(leased.runId))!;
    expect(after.dispatchOwner).toBe('instance-alive');
  });

  it('does NOT reclaim a TERMINAL run (completed/failed/cancelled)', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 10 * 60_000).toISOString();
    const done = await seedRun({ createdAt: oldIso, updatedAt: oldIso, status: 'completed' });
    await storage.setRunDispatchLease(done.runId, 'instance-crashed', now - 1_000);

    const claimed = await storage.claimOrphanedRuns(
      'worker-A',
      now,
      new Date(now - GRACE_MS).toISOString(),
      RUN_DISPATCH_LEASE_MS,
      10,
    );
    expect(claimed.map((r) => r.runId)).not.toContain(done.runId);
  });
});

describe('ENG-1 sweepOrphanedRuns — re-dispatch decision logic', () => {
  /** A REAL host suite with only `workflowCatalog.getWorkflow` overridden —
   *  that method is the only thing sweep consults before deciding to
   *  re-dispatch; everything else (providerPolicyResolver et al.) comes from
   *  the genuine factory, so this is fully typed with no cast. */
  function makeDeps(getWorkflow: RunSweeperDeps['hostSuite']['workflowCatalog']['getWorkflow']): RunSweeperDeps {
    const hostSuite = createHostAdapterSuite({ storage });
    return {
      storage,
      hostSuite: {
        ...hostSuite,
        workflowCatalog: { ...hostSuite.workflowCatalog, getWorkflow },
      },
    };
  }

  it('skips (does not crash on) an orphan whose workflow is missing from the catalog', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 10 * 60_000).toISOString();
    const orphan = await seedRun({ createdAt: oldIso, updatedAt: oldIso });
    await storage.setRunDispatchLease(orphan.runId, 'crashed', now - 1_000);

    // getWorkflow returns null ⇒ sweep logs + continues, never re-dispatches.
    const deps = makeDeps(async () => null);
    const redispatched = await sweepOrphanedRuns(deps, 'worker-sweep', now);
    expect(redispatched).toBe(0);

    // The run was still CLAIMED (fresh lease stamped) even though re-dispatch was skipped.
    const after = (await storage.getRun(orphan.runId))!;
    expect(after.dispatchOwner).toBe('worker-sweep');
    expect(after.dispatchLeaseExpiresAt!).toBeGreaterThan(now);
  });

  it('abandons a CHRONICALLY-orphaned run (older than the re-dispatch ceiling) with a terminal failure', async () => {
    const now = Date.now();
    // Older than MAX_REDISPATCH_AGE_MS ⇒ presumed genuinely stuck ⇒ failed, not re-run.
    const ancientIso = new Date(now - MAX_REDISPATCH_AGE_MS - 60_000).toISOString();
    const orphan = await seedRun({ createdAt: ancientIso, updatedAt: ancientIso });
    await storage.setRunDispatchLease(orphan.runId, 'crashed', now - 1_000);

    // getWorkflow would succeed, but the abandon branch fires before it's consulted.
    const deps = makeDeps(async () => {
      throw new Error('getWorkflow must not be called for an abandoned orphan');
    });
    const redispatched = await sweepOrphanedRuns(deps, 'worker-sweep', now);
    expect(redispatched).toBe(0);

    const after = (await storage.getRun(orphan.runId))!;
    expect(after.status).toBe('failed');
    expect(after.error?.code).toBe('dispatch_abandoned');
    const events = await storage.listEvents(orphan.runId);
    expect(events.some((e) => e.type === 'run.failed')).toBe(true);
  });

  it('a sweep with no orphans is a no-op', async () => {
    const now = Date.now();
    await seedRun({ status: 'completed' }); // terminal ⇒ never an orphan
    const deps = makeDeps(async () => {
      throw new Error('getWorkflow must not be called when nothing is orphaned');
    });
    expect(await sweepOrphanedRuns(deps, 'worker-sweep', now)).toBe(0);
  });
});
