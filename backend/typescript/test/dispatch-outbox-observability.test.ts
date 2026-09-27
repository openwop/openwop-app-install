/**
 * ADR 0551 P2 — the outbox's metrics and its redrive CAS.
 *
 * `docs/SLO.md` listed these three signals under "Not yet measurable" and said
 * exactly why: instrumenting a queue that does not exist produces metrics
 * permanently at zero, and a flat zero reads as health. P1 shipped the queue, so
 * this is the half it deliberately left.
 *
 * ── THE STANDARD, INHERITED FROM ADR 0556 P1 ───────────────────────────────
 *
 * Every metric assertion is `toEqual` on the WHOLE attribute object, read from
 * the emission ledger (which records after the cardinality guard, so the thing
 * asserted is the thing an exporter would see). `toMatchObject` would pass an
 * attribute the catalog does not declare — those are DROPPED silently, which is
 * the failure mode that makes a metric look instrumented and arrive dimensionless.
 * Each leg is driven through the REAL sweeper, so deleting an emit call at its
 * call site turns a leg red rather than leaving it green against a helper.
 *
 * ── AND THE TWO-FENCE TRAP, WHICH P1 HIT TWICE ─────────────────────────────
 *
 * `sweepDispatchOutbox` has three independent reasons to discharge an intent
 * (run gone / run left pending / live lease). A test that exercises two of them
 * at once proves neither. The `run-missing` and `discharged` legs below are
 * therefore each isolated to ONE reason, and the run-status leg explicitly
 * clears the dispatch lease first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { sweepDispatchOutbox, sweepOrphanedRuns } from '../src/host/runDispatchSweeper.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { __resetRunStartContributors } from '../src/host/runStartContext.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import {
  _resetMetricsForTest,
  emissionsOf,
  labelViolations,
  METRIC_CATALOG,
  type MetricEmission,
} from '../src/observability/metrics.js';

ensureNodesRegistered();
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-outbox-obs-')) });

const NOW = 1_700_000_000_000;
const nowIso = new Date(NOW).toISOString();

function makeRun(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    workflowId: 'wf-1',
    tenantId: 't1',
    status: 'pending',
    inputs: null,
    metadata: {},
    configurable: {},
    createdAt: nowIso,
    updatedAt: nowIso,
    ...over,
  };
}

function stubHostSuite(getWorkflow?: () => Promise<{ workflowId: string; definition: unknown } | null>): HostAdapterSuite {
  return {
    workflowCatalog: {
      getWorkflow: getWorkflow ?? (async () => ({
        workflowId: 'wf-1',
        definition: { workflowId: 'wf-1', nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [] },
      })),
    },
    providerPolicyResolver: undefined,
  } as unknown as HostAdapterSuite;
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The recovery counter's emissions, as `{lane, outcome}` pairs in record order. */
function recoveries(): Array<Record<string, unknown>> {
  return emissionsOf('openwop.dispatch.lease.recovered').map((e) => e.attributes as Record<string, unknown>);
}

function depthFor(state: 'pending' | 'dead'): MetricEmission | undefined {
  return emissionsOf('openwop.dispatch.outbox.depth').find((e) => e.attributes.state === state);
}

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  __resetRunStartContributors();
  _resetMetricsForTest();
});
afterEach(() => {
  // A label the catalog does not declare is DROPPED, not refused — so an
  // instrumented seam can look correct and export nothing useful. Every test in
  // this file asserts zero violations rather than trusting the attribute
  // objects it just wrote.
  expect([...labelViolations().entries()]).toEqual([]);
});

describe('ADR 0551 P2 — the three signals are declared as a closed set', () => {
  it('all three are in the catalog, with bounded labels and the right kinds', () => {
    const byName = new Map(METRIC_CATALOG.map((m) => [m.name, m]));
    expect(byName.get('openwop.dispatch.outbox.depth')).toMatchObject({ kind: 'gauge', labels: ['state'] });
    expect(byName.get('openwop.dispatch.outbox.oldest_age')).toMatchObject({ kind: 'gauge', unit: 's', labels: [] });
    expect(byName.get('openwop.dispatch.lease.recovered')).toMatchObject({ kind: 'counter', labels: ['lane', 'outcome'] });
  });
});

describe('ADR 0551 P2 — backlog depth and oldest age', () => {
  it('are observed on EVERY pass, including an empty queue', async () => {
    // The empty case matters most. Skipping the emission when there is nothing
    // to report leaves the last non-zero sample as the newest the exporter ever
    // saw — a drained backlog that looks permanently stuck.
    await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', NOW);

    expect(depthFor('pending')).toEqual({ name: 'openwop.dispatch.outbox.depth', value: 0, attributes: { state: 'pending' } });
    expect(depthFor('dead')).toEqual({ name: 'openwop.dispatch.outbox.depth', value: 0, attributes: { state: 'dead' } });
    expect(emissionsOf('openwop.dispatch.outbox.oldest_age')).toEqual([
      { name: 'openwop.dispatch.outbox.oldest_age', value: 0, attributes: {} },
    ]);
  });

  it('report the queue an OPERATOR would see, not the residue the pass leaves behind', async () => {
    // Two intents, both of which this pass RETIRES (a discharged intent is
    // DELETED, per P1). The observation is taken before the drain, so the depth
    // is the backlog that existed — which is the number an operator is asking
    // about. Taken at the END of the pass it would be 0 on every healthy tick,
    // and a queue that is never observed to be non-empty is unmonitorable.
    await insertRunWithStartContext(storage, makeRun({ runId: 'r1' }), { enqueueDispatch: true });
    await insertRunWithStartContext(storage, makeRun({ runId: 'r2' }), { enqueueDispatch: true });
    // The LATER of the two due times, not the first row's. Each row's grace
    // window runs from its OWN insert, so under load the two land in different
    // milliseconds and a `now` taken from r1 leaves r2 not yet due — one row
    // claimed, one left pending. This test was green in isolation and failed in
    // the full suite for exactly that reason.
    const due = Math.max(
      (await storage.getDispatchOutbox('r1'))!.nextAttemptAt,
      (await storage.getDispatchOutbox('r2'))!.nextAttemptAt,
    );
    await storage.deleteRun('r1');
    await storage.deleteRun('r2');

    await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', due);
    await flush();

    expect(depthFor('pending')?.value).toBe(2);
    expect(depthFor('dead')?.value).toBe(0);
    // …and the pass really did drain them, so the 2 above is not simply a queue
    // that never moved.
    expect((await storage.dispatchOutboxStats()).pending).toBe(0);
  });

  it('age is measured from the row CREATION, in seconds, and never negative', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'old' }), { enqueueDispatch: true });
    const row = (await storage.getDispatchOutbox('old'))!;
    const createdMs = Date.parse(row.createdAt);

    // Ten minutes after the row was created. Deriving the expectation from the
    // row's `nextAttemptAt` instead would be true for any implementation — the
    // P1 grace-window test was green for exactly that reason before it was
    // rewritten, so this probes with a wall-clock offset from `createdAt`.
    await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', createdMs + 600_000);
    await flush();

    const [age] = emissionsOf('openwop.dispatch.outbox.oldest_age');
    expect(age?.attributes).toEqual({});
    expect(age?.value).toBeCloseTo(600, 0);
  });

  it('counts dead rows separately — a dead intent is NOT backlog', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'doomed' }), { enqueueDispatch: true });
    const deps = { storage, hostSuite: stubHostSuite(async () => null) };
    let at = (await storage.getDispatchOutbox('doomed'))!.nextAttemptAt;
    for (let i = 0; i < 5; i++) {
      await sweepDispatchOutbox(deps, 'w1', at);
      at = (await storage.getDispatchOutbox('doomed'))!.nextAttemptAt;
    }
    expect((await storage.getDispatchOutbox('doomed'))?.status).toBe('dead');

    _resetMetricsForTest();
    await sweepDispatchOutbox(deps, 'w1', at + 86_400_000);
    expect(depthFor('dead')?.value).toBe(1);
    expect(depthFor('pending')?.value).toBe(0);
    // …and the oldest-age gauge does NOT count it. A dead row has stopped
    // waiting; reporting a day-old backlog for it would make the one signal an
    // operator pages on permanently red after a single give-up.
    expect(emissionsOf('openwop.dispatch.outbox.oldest_age')[0]?.value).toBe(0);
  });
});

describe('ADR 0551 P2 — lease.recovered classifies what the worker DID', () => {
  it('counts a real dispatch', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'go' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('go'))!.nextAttemptAt;
    expect(await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', due)).toBe(1);
    await flush();
    expect(recoveries()).toEqual([{ lane: 'outbox', outcome: 'dispatched' }]);
  });

  it('counts a duplicate delivery as DISCHARGED — refusing to double-start is healthy', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'dup' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('dup'))!.nextAttemptAt;
    await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', due);
    await flush();
    // ISOLATE the status fence from the live-lease fence: with the lease still
    // in place BOTH would discharge the row, and neither would be proven. This
    // is the same trap that made P1's S4 sabotage stay green.
    await storage.setRunDispatchLease('dup', null, null);
    expect((await storage.getRun('dup'))!.status).not.toBe('pending');

    _resetMetricsForTest();
    const at = (await storage.getDispatchOutbox('dup'))!.nextAttemptAt;
    expect(await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w2', at)).toBe(0);
    expect(recoveries()).toEqual([{ lane: 'outbox', outcome: 'discharged' }]);
  });

  it('counts an intent whose run vanished', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'gone' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('gone'))!.nextAttemptAt;
    await storage.deleteRun('gone');

    await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', due);
    expect(recoveries()).toEqual([{ lane: 'outbox', outcome: 'run-missing' }]);
  });

  it('separates a bounded RETRY from the terminal give-up', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'unresolvable' }), { enqueueDispatch: true });
    const deps = { storage, hostSuite: stubHostSuite(async () => null) };
    let at = (await storage.getDispatchOutbox('unresolvable'))!.nextAttemptAt;
    for (let i = 0; i < 5; i++) {
      await sweepDispatchOutbox(deps, 'w1', at);
      at = (await storage.getDispatchOutbox('unresolvable'))!.nextAttemptAt;
    }
    // Four retries then one `dead`, in order — the shape an operator alerts on
    // (`dead` is rare and actionable; `retried` is noisy and is not).
    expect(recoveries()).toEqual([
      { lane: 'outbox', outcome: 'retried' },
      { lane: 'outbox', outcome: 'retried' },
      { lane: 'outbox', outcome: 'retried' },
      { lane: 'outbox', outcome: 'retried' },
      { lane: 'outbox', outcome: 'dead' },
    ]);
  });

  it('labels the ORPHAN lane distinctly — one counter, two mechanisms', async () => {
    // The lease-expiry lane is the other half of "lease recovered", and it is
    // reached by a completely different path (a stale run row, no outbox intent
    // at all). Sharing a counter without the `lane` label would make a spike
    // unattributable to either mechanism.
    const old = new Date(NOW - 3_600_000 * 0.5).toISOString();
    await insertRunWithStartContext(storage, makeRun({ runId: 'orphan', createdAt: old, updatedAt: old }));
    expect(await sweepOrphanedRuns({ storage, hostSuite: stubHostSuite() }, 'w1', NOW)).toBe(1);
    await flush();
    expect(recoveries()).toEqual([{ lane: 'orphan', outcome: 'dispatched' }]);
  });
});

describe('ADR 0551 P2 — redrive is a compare-and-set', () => {
  async function makeDeadRow(runId: string): Promise<void> {
    await insertRunWithStartContext(storage, makeRun({ runId }), { enqueueDispatch: true });
    const deps = { storage, hostSuite: stubHostSuite(async () => null) };
    let at = (await storage.getDispatchOutbox(runId))!.nextAttemptAt;
    for (let i = 0; i < 5; i++) {
      await sweepDispatchOutbox(deps, 'w1', at);
      at = (await storage.getDispatchOutbox(runId))!.nextAttemptAt;
    }
    expect((await storage.getDispatchOutbox(runId))?.status).toBe('dead');
  }

  it('re-queues a dead intent with a FRESH attempts budget', async () => {
    await makeDeadRow('revive');
    expect(await storage.redriveDispatchOutbox('revive', NOW, 'operator: workflow restored')).toBe(true);

    const row = (await storage.getDispatchOutbox('revive'))!;
    expect(row.status).toBe('pending');
    // Zero, not "decremented": re-queueing a row whose budget is already spent
    // would have it die again on the very next claim, which is a redrive that
    // does nothing while reporting success.
    expect(row.attempts).toBe(0);
    expect(row.claimedBy).toBeNull();
    expect(row.claimExpiresAt).toBeNull();
    // The reason lands on the ROW, so the queue itself carries why an exhausted
    // budget was overridden.
    expect(row.lastError).toContain('workflow restored');
    // And it is genuinely deliverable again.
    expect(await storage.claimDispatchOutbox('w1', NOW, 60_000, 10)).toHaveLength(1);
  });

  it('CONCURRENT double-redrive produces exactly ONE re-queued row', async () => {
    await makeDeadRow('raced');
    const [a, b] = await Promise.all([
      storage.redriveDispatchOutbox('raced', NOW, 'operator A'),
      storage.redriveDispatchOutbox('raced', NOW, 'operator B'),
    ]);
    // Exactly one caller performed the transition. A read-then-write would let
    // BOTH observe `dead` and both write `pending` — the "state machine is not a
    // CAS" failure that has already double-fired a refund in this codebase. The
    // predicate is inside the writing statement, so the loser learns it lost.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await storage.getDispatchOutbox('raced'))?.status).toBe('pending');
    // And there is still ONE row, delivered once.
    expect(await storage.claimDispatchOutbox('w1', NOW, 60_000, 10)).toHaveLength(1);
  });

  it('refuses a row that is not dead, and one that does not exist', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'alive' }), { enqueueDispatch: true });
    // A pending row is NOT redrivable: resetting its attempts would silently
    // extend a budget the worker is still spending.
    expect(await storage.redriveDispatchOutbox('alive', NOW, 'nope')).toBe(false);
    expect((await storage.getDispatchOutbox('alive'))?.lastError ?? null).toBeNull();
    expect(await storage.redriveDispatchOutbox('no-such-run', NOW, 'nope')).toBe(false);
  });
});

describe('ADR 0551 P2 — the stats read is an aggregate, not a page count', () => {
  it('counts the whole table and finds the OLDEST pending row', async () => {
    const older = new Date(NOW - 3_600_000).toISOString();
    await insertRunWithStartContext(storage, makeRun({ runId: 'a', createdAt: older, updatedAt: older }), { enqueueDispatch: true });
    await insertRunWithStartContext(storage, makeRun({ runId: 'b' }), { enqueueDispatch: true });

    const stats = await storage.dispatchOutboxStats();
    expect(stats).toEqual({ pending: 2, dead: 0, oldestPendingCreatedAt: older });
  });

  it('listing is capped while the counts are not — so a deep queue is reported honestly', async () => {
    for (let i = 0; i < 3; i++) {
      await insertRunWithStartContext(storage, makeRun({ runId: `p${i}` }), { enqueueDispatch: true });
    }
    expect((await storage.listDispatchOutbox({ status: 'pending', limit: 2 }))).toHaveLength(2);
    expect((await storage.dispatchOutboxStats()).pending).toBe(3);
  });
});
