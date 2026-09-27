/**
 * WF-COS-4 — a dropped or failed schedule fire must not report as a run.
 *
 * THE DEFECT. `processDueSchedules` calls `markJobFired` BEFORE dispatch — and
 * it must, because the claim row is permanent, so advancing the slot only after
 * dispatch would let a crash wedge the schedule forever. But `markJobFired`
 * unconditionally stamped `lastRunAt = now` while leaving `lastRunId` at the
 * PREVIOUS fire's value. Three bail-outs follow that call (over-budget,
 * unresolved workflow, thrown dispatch) and none retracted the claim. Every
 * consumer renders the pair together: the assistant loop panel said "last run:
 * just now" beside a `/runs/<id>` link to a run from hours earlier — a run that
 * never happened, reported as one that did.
 *
 * THE FIX IS IN THE CALLERS, NOT IN `markJobFired`. This docblock used to claim
 * "`lastRunAt` is now stamped only alongside a `runId`" — false, and it was the
 * same false sentence that sat on the field's own declaration. `markJobFired`'s
 * body is byte-identical to `origin/main` and still stamps `lastRunAt`
 * unconditionally. What changed is that the dispatch paths stopped calling it:
 * the daemon uses `advanceJobSlot` + `recordJobRun`/`recordJobSkipped`, and the
 * trigger route (round 2, below) does the same when a BOUND workflow fails to
 * resolve. So the pair always describes ONE run because no caller stamps half
 * of it — a discipline, which is why both lanes are tested rather than trusted.
 *
 * This is PROBE-COS-4 as an automated case: the assessment's expected reading
 * was "`lastRunAt` was advanced (it will be, today)".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerJob, updateJob, getJob, resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: {
    // An unknown workflow resolves to null → `startWorkflowRun` returns no runId
    // → the "advanced past slot" bail-out. `wf-1` resolves normally.
    getWorkflow: async (id) => (id === 'wf-1' ? { workflowId: id, definition: { workflowId: id, nodes: [] } } : null),
  },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

const T0 = Date.parse('2026-06-02T10:15:00Z');
const SLOT = Date.parse('2026-06-02T11:00:00Z');

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await resetScheduling();
  deps = { storage, hostSuite };
});
afterEach(() => { __resetHostExtPersistence(); });

describe('WF-COS-4 — the slot advance is not a claim that a run happened', () => {
  it('an UNRESOLVED workflow advances the slot, leaves lastRunAt/lastRunId absent, and records WHY', async () => {
    await registerJob({ jobId: 'jx', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-missing', timezone: 'UTC' }, T0);
    const now = SLOT + 30_000;
    expect(await processDueSchedules(deps, now)).toBe(0);

    const job = await getJob('jx');
    // The slot MUST still advance — that is what stops a crash wedging the
    // schedule, and it is why the stamp could not simply be moved.
    expect(job?.nextFireAt, 'the slot must advance even when nothing ran').toBeGreaterThan(now);
    // …and NOTHING may claim a run.
    expect(job?.lastRunAt, 'no run happened — this must not be stamped').toBeUndefined();
    expect(job?.lastRunId).toBeUndefined();
    // …while the fact that a fire was consumed and produced nothing IS recorded,
    // so the surface can say so instead of showing silence.
    expect(job?.lastSkippedAt).toBeTruthy();
    expect(job?.lastSkipReason).toBe('workflow-unresolved');
  });

  it('the STALE-PAIR case: a successful run then a dropped fire must not move lastRunAt off its run', async () => {
    // This is the shape the loop panel actually rendered. Without the fix the
    // second pass advanced `lastRunAt` to the later timestamp while `lastRunId`
    // still pointed at the FIRST run — "last run: just now", linking hours back.
    await registerJob({ jobId: 'jy', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(1);
    const afterRun = await getJob('jy');
    expect(afterRun?.lastRunId).toBeTruthy();
    const stampedAt = afterRun!.lastRunAt!;
    expect(stampedAt).toBeTruthy();

    // Re-point the same job at a workflow that will not resolve, then fire the
    // next slot: the fire is consumed and produces nothing.
    await updateJob('jy', { workflowId: 'wf-missing' });
    const later = (await getJob('jy'))!.nextFireAt! + 30_000;
    await processDueSchedules(deps, later);

    const final = await getJob('jy');
    expect(final?.lastRunAt, 'the pair must still describe the run that really happened').toBe(stampedAt);
    expect(final?.lastRunId).toBe(afterRun!.lastRunId);
    expect(final?.lastSkippedAt, 'and the failure since then must be visible').toBeTruthy();
  });

  it('a fire that DOES run clears an earlier skip note (the mirror-image defect)', async () => {
    // A skip note that outlived the problem would warn about a state that has
    // resolved — the same class of lie, pointing the other way.
    await registerJob({ jobId: 'jz', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-missing', timezone: 'UTC' }, T0);
    await processDueSchedules(deps, SLOT + 30_000);
    expect((await getJob('jz'))?.lastSkipReason).toBe('workflow-unresolved');

    await updateJob('jz', { workflowId: 'wf-1' });
    const later = (await getJob('jz'))!.nextFireAt! + 30_000;
    expect(await processDueSchedules(deps, later)).toBe(1);

    const healed = await getJob('jz');
    expect(healed?.lastSkippedAt).toBeUndefined();
    expect(healed?.lastSkipReason).toBeUndefined();
    expect(healed?.lastRunAt).toBeTruthy();
    expect(healed?.lastRunId).toBeTruthy();
  });
});
