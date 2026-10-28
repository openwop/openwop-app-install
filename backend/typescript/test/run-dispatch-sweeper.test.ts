/**
 * Multi-instance run-dispatch crash recovery. Exercises the storage claim
 * semantics (the correctness crux) against the in-memory sqlite backend, plus
 * one sweeper re-dispatch pass with a stub host suite.
 *
 *   - claimOrphanedRuns claims ONLY genuinely-orphaned runs: pending/running,
 *     past the createdAt grace window, with an absent/expired lease.
 *   - It excludes fresh runs (grace), live-leased runs, terminal runs, and
 *     parked (waiting-*) runs.
 *   - setRunDispatchLease parks a run out of the sweep until the lease expires.
 *   - sweepOrphanedRuns re-claims the orphan under the sweeper's worker id.
 *
 * Breaks it (round-1 probes, witnessed): the createdAt grace (8fw2g2-rds-grace),
 * the lease-expiry predicate (rds-lease), the status filter (rds-status), the
 * abandon ceiling (rds-abandon), the closed-log reconcile (rds-reconcile) and
 * its refused-append fallback (rds-fallback).
 *
 * DOUBLE GUARD (by design) on the OLD closed-log case: with the `closedBy`
 * pre-check removed, the abandon path's `RunLogClosedError` catch reconciles
 * anyway. The 'YOUNG' case isolates the pre-check (no abandon path under the
 * ceiling) and 'falls back' isolates the catch (no `runLogClosedBy`), which is
 * why rds-reconcile and rds-fallback are each witnessed on one case.
 *
 * The host suite is the real `createHostAdapterSuite` with only the workflow
 * catalog replaced (typed, no cast).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { createHostAdapterSuite, type HostAdapterSuite, type WorkflowCatalog } from '../src/host/index.js';
import { sweepOrphanedRuns } from '../src/host/runDispatchSweeper.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const oldIso = new Date(NOW - HOUR).toISOString(); // well past the grace window
const freshIso = new Date(NOW).toISOString();

function makeRun(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    workflowId: 'wf-1',
    tenantId: 't1',
    status: 'pending',
    inputs: null,
    metadata: {},
    configurable: {},
    createdAt: oldIso,
    updatedAt: oldIso,
    ...over,
  };
}

describe('run-dispatch crash recovery', () => {
  let storage: Storage;
  const stubCatalog: WorkflowCatalog['getWorkflow'] = async (id) => ({ workflowId: id, definition: { workflowId: 'wf-1', nodes: [] } });
  /** The real host suite with only the workflow catalog replaced. */
  const suiteWith = (getWorkflow: WorkflowCatalog['getWorkflow'] = stubCatalog): HostAdapterSuite => ({
    ...createHostAdapterSuite({ storage }),
    workflowCatalog: { getWorkflow },
  });
  beforeEach(async () => {
    storage = await openStorage('memory://');
  });
  afterEach(() => vi.restoreAllMocks());

  it('claims only genuinely-orphaned runs', async () => {
    await storage.insertRun(makeRun({ runId: 'old-pending', status: 'pending' }));
    await storage.insertRun(makeRun({ runId: 'old-running', status: 'running' }));
    await storage.insertRun(makeRun({ runId: 'fresh', status: 'pending', createdAt: freshIso }));
    await storage.insertRun(makeRun({ runId: 'done', status: 'completed' }));
    await storage.insertRun(makeRun({ runId: 'parked', status: 'waiting-input' }));

    const claimed = await storage.claimOrphanedRuns('sweeper-a', NOW, new Date(NOW - 60_000).toISOString(), 720_000, 10);
    expect(claimed.map((r) => r.runId).sort()).toEqual(['old-pending', 'old-running']);
    // Claimed rows carry the new owner + a fresh lease.
    for (const r of claimed) {
      expect(r.dispatchOwner).toBe('sweeper-a');
      expect(r.dispatchLeaseExpiresAt).toBe(NOW + 720_000);
    }
  });

  it('excludes a run holding a live lease, then re-claims it once the lease expires', async () => {
    await storage.insertRun(makeRun({ runId: 'leased', status: 'running' }));
    // A live lease 10 min in the future → not orphaned.
    await storage.setRunDispatchLease('leased', 'instance-x', NOW + 600_000);
    expect(await storage.claimOrphanedRuns('sweeper-a', NOW, new Date(NOW - 60_000).toISOString(), 720_000, 10)).toEqual([]);

    // After the lease expires, it's re-claimable.
    const after = await storage.claimOrphanedRuns('sweeper-a', NOW + 600_001, new Date(NOW).toISOString(), 720_000, 10);
    expect(after.map((r) => r.runId)).toEqual(['leased']);
    expect(after[0]!.dispatchOwner).toBe('sweeper-a');
  });

  it('does not claim the same run twice within one lease window', async () => {
    await storage.insertRun(makeRun({ runId: 'once', status: 'running' }));
    const first = await storage.claimOrphanedRuns('sweeper-a', NOW, new Date(NOW - 60_000).toISOString(), 720_000, 10);
    expect(first.map((r) => r.runId)).toEqual(['once']);
    // Immediately re-claiming finds nothing (the row now holds a fresh lease).
    expect(await storage.claimOrphanedRuns('sweeper-b', NOW + 1, new Date(NOW).toISOString(), 720_000, 10)).toEqual([]);
  });

  it('sweepOrphanedRuns re-claims and reports orphaned runs', async () => {
    await storage.insertRun(makeRun({ runId: 'orphan', status: 'running' }));
    const redispatched = await sweepOrphanedRuns({ storage, hostSuite: suiteWith() }, 'sweeper-a', NOW);
    expect(redispatched).toBe(1);
    // The orphan now belongs to the sweeper (claimed before re-dispatch).
    const run = await storage.getRun('orphan');
    expect(run?.dispatchOwner).toBe('sweeper-a');
  });

  it('abandons (fails) a chronically-orphaned run instead of re-dispatching it forever', async () => {
    setEventLogBackend(storage); // emitTerminalFailure appends run.failed
    // Created > 1h ago and still running → past the re-dispatch ceiling.
    await storage.insertRun(makeRun({ runId: 'stuck', status: 'running', createdAt: new Date(NOW - 2 * HOUR).toISOString() }));
    const redispatched = await sweepOrphanedRuns({ storage, hostSuite: suiteWith() }, 'sweeper-a', NOW);
    expect(redispatched).toBe(0); // abandoned, not re-dispatched
    const run = await storage.getRun('stuck');
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('dispatch_abandoned');
  });

  // ── EVID-3: a run whose LOG is closed but whose ROW is not terminal ─────────
  // Ten such runs sat on production for days: every sweep tried to abandon
  // them, the closed log refused `run.failed`, and each attempt appended one
  // more `run.dead_lettered`. The row follows the log; nothing is appended.
  const closeLog = (runId: string, type: string) =>
    storage.appendEvent({ eventId: `e-${runId}`, runId, type, payload: null, timestamp: oldIso });
  const eventTypes = async (runId: string) => (await storage.listEvents(runId)).map((e) => e.type);

  it('reconciles a chronically-orphaned run whose log is already closed, appending nothing', async () => {
    setEventLogBackend(storage);
    const old = new Date(NOW - 2 * HOUR).toISOString(); // past the abandon ceiling
    await storage.insertRun(makeRun({ runId: 'ended-cancelled', status: 'running', createdAt: old }));
    await storage.insertRun(makeRun({ runId: 'ended-failed', status: 'pending', createdAt: old }));
    await closeLog('ended-cancelled', 'run.cancelled');
    await closeLog('ended-failed', 'run.failed');

    expect(await sweepOrphanedRuns({ storage, hostSuite: suiteWith() }, 'sweeper-a', NOW)).toBe(0);
    expect((await storage.getRun('ended-cancelled'))?.status).toBe('cancelled');
    expect((await storage.getRun('ended-failed'))?.status).toBe('failed');
    expect((await storage.getRun('ended-failed'))?.completedAt).toBeTruthy();
    // The log is untouched: no dead-letter record, no second terminal.
    expect(await eventTypes('ended-cancelled')).toEqual(['run.cancelled']);
    expect(await eventTypes('ended-failed')).toEqual(['run.failed']);
    // …and they are no longer orphans: a later sweep claims nothing.
    expect(await storage.claimOrphanedRuns('sweeper-b', NOW + HOUR, new Date(NOW).toISOString(), 720_000, 10)).toEqual([]);
  });

  it('reconciles a YOUNG closed-log run too, instead of re-dispatching it until the ceiling', async () => {
    setEventLogBackend(storage);
    // 30 min old: past the grace window, well under the 1 h abandon ceiling.
    await storage.insertRun(makeRun({ runId: 'ended-completed', status: 'running', createdAt: new Date(NOW - HOUR / 2).toISOString() }));
    await closeLog('ended-completed', 'run.completed');
    const getWorkflow = vi.fn(stubCatalog);

    expect(await sweepOrphanedRuns({ storage, hostSuite: suiteWith(getWorkflow) }, 'sweeper-a', NOW)).toBe(0);
    const run = await storage.getRun('ended-completed');
    expect(run?.status).toBe('completed');
    expect(run?.error).toBeUndefined(); // a completed run gets no synthetic error
    expect(getWorkflow).not.toHaveBeenCalled(); // never reached the re-dispatch lane
    expect(await eventTypes('ended-completed')).toEqual(['run.completed']);
  });

  it('falls back to the refused append when the store cannot answer runLogClosedBy', async () => {
    setEventLogBackend(storage);
    const old = new Date(NOW - 2 * HOUR).toISOString();
    await storage.insertRun(makeRun({ runId: 'ended-legacy', status: 'running', createdAt: old }));
    await closeLog('ended-legacy', 'run.cancelled');
    // The same store with the OPTIONAL `runLogClosedBy` absent (a legacy backend).
    const without: Storage = new Proxy(storage, {
      get: (target, prop, receiver) => (prop === 'runLogClosedBy' ? undefined : Reflect.get(target, prop, receiver)),
    });
    expect(without.runLogClosedBy).toBeUndefined();

    expect(await sweepOrphanedRuns({ storage: without, hostSuite: suiteWith() }, 'sweeper-a', NOW)).toBe(0);
    expect((await storage.getRun('ended-legacy'))?.status).toBe('cancelled');
    expect(await storage.claimOrphanedRuns('sweeper-b', NOW + HOUR, new Date(NOW).toISOString(), 720_000, 10)).toEqual([]);
  });
});
