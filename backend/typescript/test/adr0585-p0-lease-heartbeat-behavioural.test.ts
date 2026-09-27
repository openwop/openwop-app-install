/**
 * ADR 0585 P0 — the lease heartbeat, asserted through BEHAVIOUR.
 *
 * COMPANION TO `adr0585-p0-lease-heartbeat.test.ts`, NOT A REPLACEMENT, and
 * narrower than its first draft claimed. That file pins the renewal PREDICATE
 * (`isLeaseRenewalDue`) and the additive invariants; its wiring legs read
 * `executor.ts` as SOURCE TEXT.
 *
 * WHAT THIS FILE ADDS, and it is not what the first draft said. The predicate
 * suite never calls `executeRun`, so it proves the arithmetic is right and the
 * call site is spelled right; it cannot show a renewal reaching storage. This
 * drives the real executor and observes actual lease writes (the dispatch
 * stamp plus every `renewRunDispatchLeaseIfOwner` heartbeat — ADR 0585 P0b).
 *
 * The coverage that only this file has is RENEWAL THAT OUTLIVES THE RUN — the
 * false-ALIVE shape. Sabotage: add a detached `setInterval` renewal alongside
 * the loop-driven one.
 *
 *   this file  -> RED twice: `expected 12 to be 7` (a finished run kept
 *                 renewing) and `expected 6 to be 1` (a suspended run kept
 *                 renewing)
 *   predicate suite -> 12 passed
 *
 * It passes there because the sabotage ADDS code rather than changing any line
 * the source-text legs match, and no amount of grepping for what IS present can
 * see what has been added beside it. That matters more than it looks: the
 * timer-driven design is the obvious way to "fix" heartbeat starvation, and it
 * is wrong in the direction P1 cannot tolerate. A `setInterval` fires
 * independently of the scheduler, so a WEDGED run keeps renewing and keeps
 * asserting liveness for work making no progress — a false-alive that P1's
 * shorter reclaim threshold would believe. Starvation is a false-dead and costs
 * availability; this costs correctness. So the leg exists to stop a plausible
 * future fix, not to re-check today's code.
 *
 * SUSPEND is the same guard at the other end, and it is safe to assert because
 * the orphan query is `status IN ('pending','running')`
 * (`storage/sqlite/index.ts:193`) — a `waiting-*` run is never a reclaim
 * candidate, so releasing its lease cannot cause a re-dispatch.
 *
 * WHAT IT DOES *NOT* DO, MEASURED RATHER THAN ASSUMED. The first version of this
 * docstring claimed it was a behavioural gate for the wait branch's heartbeat
 * wake, where the predicate suite has only
 * `expect(src).toMatch(/Promise\.race\(\[settled, retried, deadlineHit, heartbeatDue\]\)/)`.
 * Three sabotages say otherwise:
 *
 *   | sabotage                                   | wakes  | renewals | this file |
 *   |--------------------------------------------|--------|----------|-----------|
 *   | (none)                                     | 5      | 3        | pass      |
 *   | `heartbeatDue` REMOVED from the race       | 2      | 0        | RED       |
 *   | beat delay x100_000, race line untouched   | 90_002 | 3        | pass      |
 *
 * Removal is caught — but the source-text leg catches removal too, because
 * removal changes the line it matches. The line-PRESERVING break is not caught,
 * and the reason is structural: renewal pacing is governed by the TIME predicate
 * (`isLeaseRenewalDue`), not by how often the loop wakes, so as long as
 * something turns the loop the renewals arrive on schedule regardless of which
 * arm woke it. Wake frequency is simply not observable from the storage writes
 * this test can see.
 *
 * So neither suite pins the wake MECHANISM, and this one should not be read as
 * doing so. The honest status of that leg is: the finding is real, it was found
 * by reading the loop, and it is currently pinned only by the spelling of one
 * line. Pinning it properly needs an observable that distinguishes "the loop
 * woke because of the heartbeat" from "the loop woke for some other reason" —
 * which the current seams do not expose. ADR 0585 P1 should not treat the wake
 * as test-covered.
 *
 * A NEGATIVE RESULT, recorded so nobody re-derives it. The x100_000 sabotage
 * above woke the wait branch 90_002 times over 90s of fake time instead of 5,
 * which looked like a latent busy-loop. It is not reachable. Wake census on
 * UNMODIFIED code (`git diff --quiet` asserted either side, so the baseline is
 * not a claim):
 *
 *   default 600s deadline, 90s advanced  -> 4 wakes
 *   runTimeoutMs 20_000, 25s advanced    -> 1 wake
 *   runTimeoutMs 45_000, 50s advanced    -> 2 wakes
 *
 * The specific hypothesis was that the spin condition is `beat > remaining`,
 * which is NOT exotic — `remaining` shrinks toward zero on every run, so the
 * last 30s of any run approaching its duration cap satisfies it, and a burn
 * there would hit every capped run's tail. The 20s row IS that state and gives
 * one wake. The reason is self-limiting: the same shrinking `remaining` that
 * makes `beat > remaining` true is also the `deadlineHit` delay, so whenever the
 * beat stops bounding the wait, the deadline is already about to fire. The two
 * arms cannot both be far away. The sabotage broke that by pushing the beat to
 * ~35 days while leaving `remaining` at 600s — a gap the code cannot produce.
 * Conclusion: a fake-timer artefact, not a production behaviour.
 *
 * WHY THE BLOCKING NODE BLOCKS ON A PROMISE AND NEVER A TIMER: the whole file
 * runs under fake timers, so a node that slept on `setTimeout` would be
 * completed by the very `advanceTimersByTimeAsync` calls that drive the
 * heartbeat, and the "long-running node" would not be long-running at all. The
 * test holds the resolver and releases it explicitly.
 */

import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { executeRun, RUN_LEASE_HEARTBEAT_MS } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-hb-b-')) });

let releaseBlockingNode: () => void = () => {};

beforeAll(() => {
  const registry = getNodeRegistry();
  registry.register({
    typeId: 'test.lease.blocking',
    version: '1.0.0',
    async execute() {
      await new Promise<void>((resolve) => { releaseBlockingNode = resolve; });
      return { status: 'success', outputs: { output: null } };
    },
  });
  registry.register({
    typeId: 'test.lease.suspending',
    version: '1.0.0',
    async execute() {
      return { status: 'suspended', interrupt: { kind: 'approval', data: { why: 'lease' } } };
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let seq = 0;
async function seedRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-lease-b-${++seq}`,
    workflowId,
    tenantId: 'demo',
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

/**
 * Count lease writes for one run, so a concurrent run cannot inflate the total.
 *
 * ADR 0585 P0b — this counts BOTH mechanisms, and it has to. The dispatch-time
 * CLAIM still uses the unconditional `setRunDispatchLease`; the HEARTBEAT now
 * uses `renewRunDispatchLeaseIfOwner`, because an unconditional write is a
 * defect as a renewal (a reclaimed instance would take the run back from its new
 * owner). Counting only the old method made this suite report ONE write for a
 * run that renewed four times — a true count of the wrong thing.
 *
 * The CAS mock returns `true` deliberately: `false` means "you no longer own
 * this run", and the executor would correctly ABANDON it, so a lazily-mocked
 * `false` would test the abandon path while claiming to measure renewal.
 */
function spyLease(runId: string): { count: () => number } {
  let n = 0;
  vi.spyOn(storage, 'setRunDispatchLease').mockImplementation(async (id) => {
    if (id === runId) n += 1;
  });
  // ADR 0740 — the DISPATCH-TIME lease write is now the atomic execution claim,
  // not `setRunDispatchLease`. It is still "1 dispatch-time claim", so it still
  // counts; without this the arithmetic below reads one short and blames the
  // heartbeat for a write that simply moved.
  vi.spyOn(storage, 'claimRunExecution').mockImplementation(async (id) => {
    if (id === runId) n += 1;
    return 'claimed';
  });
  vi.spyOn(storage, 'renewRunDispatchLeaseIfOwner').mockImplementation(async (id) => {
    if (id === runId) n += 1;
    return true; // still ours — see the note above
  });
  return { count: () => n };
}

describe('ADR 0585 P0 — renewal observed through the real executor', () => {
  it('keeps renewing while ONE long-running node is in flight — the wait-branch wake, measured', async () => {
    const run = await seedRun('wf.lease.blocking');
    const lease = spyLease(run.runId);

    vi.useFakeTimers();
    const finished = executeRun(storage, run, {
      workflowId: 'wf.lease.blocking',
      nodes: [{ nodeId: 'a', typeId: 'test.lease.blocking' }],
      edges: [],
    });

    // The node never settles on its own, so every wake here is the heartbeat
    // arm of the wait branch's `Promise.race` — not a node completing.
    await vi.advanceTimersByTimeAsync(RUN_LEASE_HEARTBEAT_MS * 3);

    // 1 dispatch-time claim + >=3 renewals. Pre-P0 this was exactly 1, and it is
    // still exactly 1 if the wait branch stops waking: the loop would be parked
    // on the blocked node for the whole run-duration ceiling.
    expect(
      lease.count(),
      'a long-running node must not starve lease renewal — the wait branch has to wake for the heartbeat',
    ).toBeGreaterThanOrEqual(4);

    const duringRun = lease.count();
    releaseBlockingNode();
    await vi.advanceTimersByTimeAsync(0);
    await finished;

    // Renewal must stop when the run leaves the executor: nothing should keep
    // asserting this instance's liveness for a run it is no longer executing.
    const atEnd = lease.count();
    expect(atEnd).toBeGreaterThanOrEqual(duringRun);
    await vi.advanceTimersByTimeAsync(RUN_LEASE_HEARTBEAT_MS * 5);
    expect(lease.count(), 'a finished run must not keep renewing its lease').toBe(atEnd);
  });

  it('stops renewing when the run SUSPENDS — a waiting run is executed by nobody', async () => {
    // Safe to release the lease here, and not merely tidy: the orphan query is
    // `status IN ('pending','running')` (`storage/sqlite/index.ts:193`), so a
    // `waiting-*` run is never a reclaim candidate. Renewing across a four-hour
    // approval gate would assert liveness on behalf of no running work.
    const run = await seedRun('wf.lease.suspending');
    const lease = spyLease(run.runId);

    vi.useFakeTimers();
    const result = await executeRun(storage, run, {
      workflowId: 'wf.lease.suspending',
      nodes: [{ nodeId: 'a', typeId: 'test.lease.suspending' }],
      edges: [],
    });
    expect(result.status).toMatch(/^waiting/);

    const atSuspend = lease.count();
    await vi.advanceTimersByTimeAsync(RUN_LEASE_HEARTBEAT_MS * 5);
    expect(lease.count(), 'a suspended run must not keep renewing its lease').toBe(atSuspend);
  });
});
