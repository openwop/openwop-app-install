/**
 * ADR 0412 P4 — schedule-continuation arm/disarm wired to the real scheduler.
 *
 *  - arm creates the ONE deterministic job (`goal:<tenant>:<goalId>:continuation`)
 *    firing the consumer-supplied checkpoint workflow; `continuation.armRef`
 *    surfaces it on the wire.
 *  - the schedule daemon FIRES the armed job (integration: processDueSchedules
 *    starts a run stamped with the schedule block + goal metadata).
 *  - pause disables the job (daemon skips), resume re-enables (real arming
 *    flags — the historical no-op is retired).
 *  - a terminal judge verdict disarms — no orphaned scheduled work under a
 *    retired identity.
 *  - arming a non-`schedule` mode is refused; cross-tenant arm is not found.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getJob, resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { registerGoalVerifier, __clearGoalVerifiers } from '../src/features/goals/goalVerifiers.js';
import {
  armContinuation,
  continuationJobId,
  createGoal,
  evaluateGoal,
  transitionGoal,
  ContinuationModeError,
} from '../src/features/goals/goalsService.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

// `armContinuation` registers its job against REAL wall-clock now, so the
// deterministic daemon probes use now-relative future slots (hourly cron ⇒
// +2h/+3h/+4h are each ≥ one slot past the previous fire).
const NOW = Date.now();
const SLOT_1 = NOW + 2 * 3_600_000;
const SLOT_2 = NOW + 3 * 3_600_000;
const SLOT_3 = NOW + 4 * 3_600_000;
const TENANT = 'tenant-goal-cont';
const BOUNDS = { maxLoopIterations: 10, runTimeoutMs: 999_999_999 };

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await resetScheduling();
  deps = { storage, hostSuite };
});

afterEach(() => {
  __clearGoalVerifiers();
  __resetHostExtPersistence();
});

async function makeScheduleGoal(mode: 'schedule' | 'manual' = 'schedule'): Promise<string> {
  const g = await createGoal({
    objective: 'Continuation-armed objective',
    completion: { check: 'verifier', verifierRef: 'vc:judge' },
    continuation: { mode },
    bounds: BOUNDS,
    owner: { tenant: TENANT },
  });
  return g.id;
}

async function goalRuns(jobId: string) {
  const runs = await storage.listRuns({ limit: 100 });
  return runs.filter((r) => {
    const block = (r.metadata as Record<string, unknown>)?.schedule as Record<string, unknown> | undefined;
    return block?.jobId === jobId;
  });
}

describe('arm', () => {
  it('creates the deterministic continuation job and stamps continuation.armRef', async () => {
    const id = await makeScheduleGoal();
    const wire = await armContinuation(TENANT, id, { workflowId: 'wf:checkpoint', cronExpr: '0 * * * *' });
    const jobId = continuationJobId(TENANT, id);
    expect(wire?.continuation.armRef).toBe(jobId);
    const job = await getJob(jobId);
    expect(job?.enabled).toBe(true);
    expect(job?.workflowId).toBe('wf:checkpoint');
    expect(job?.metadata).toEqual({ goalId: id, purpose: 'goal-continuation' });
  });

  it('carries per-fire inputs onto the job so the continuation loop is seeded', async () => {
    // Regression guard for the scheduled-loop-runs-blind defect: a continuation
    // whose workflow declares variables must be able to seed them per fire.
    const id = await makeScheduleGoal();
    await armContinuation(TENANT, id, {
      workflowId: 'wf:checkpoint', cronExpr: '0 * * * *',
      inputs: { enrollmentId: 'enr:x', ownerSubject: 'user:o' },
    });
    const job = await getJob(continuationJobId(TENANT, id));
    expect(job?.inputs).toEqual({ enrollmentId: 'enr:x', ownerSubject: 'user:o' });
  });

  it('refuses to arm a non-schedule continuation mode', async () => {
    const id = await makeScheduleGoal('manual');
    await expect(armContinuation(TENANT, id, { workflowId: 'wf:x', cronExpr: '0 * * * *' })).rejects.toBeInstanceOf(
      ContinuationModeError,
    );
  });

  it('cross-tenant arm is not found', async () => {
    const id = await makeScheduleGoal();
    expect(await armContinuation('tenant-other', id, { workflowId: 'wf:x', cronExpr: '0 * * * *' })).toBeNull();
  });
});

describe('daemon integration', () => {
  it('the armed job FIRES a checkpoint run; pause stops it; resume restores it', async () => {
    const id = await makeScheduleGoal();
    await armContinuation(TENANT, id, { workflowId: 'wf:checkpoint', cronExpr: '0 * * * *' });
    const jobId = continuationJobId(TENANT, id);

    // Due at a future hourly slot → fires exactly once.
    await processDueSchedules(deps, SLOT_1);
    expect((await goalRuns(jobId)).length).toBe(1);

    // Pause → job disabled → the following slot does NOT fire.
    await transitionGoal(TENANT, id, 'pause');
    expect((await getJob(jobId))?.enabled).toBe(false);
    await processDueSchedules(deps, SLOT_2);
    expect((await goalRuns(jobId)).length).toBe(1);

    // Resume → re-enabled → fires again on a later slot.
    await transitionGoal(TENANT, id, 'resume');
    expect((await getJob(jobId))?.enabled).toBe(true);
    await processDueSchedules(deps, SLOT_3);
    expect((await goalRuns(jobId)).length).toBe(2);
  });

  it('a terminal judge verdict disarms the continuation job', async () => {
    registerGoalVerifier('vc:judge', async () => ({ satisfied: true, confidence: 1, runId: 'run-final' }));
    const id = await makeScheduleGoal();
    await armContinuation(TENANT, id, { workflowId: 'wf:checkpoint', cronExpr: '0 * * * *' });
    const jobId = continuationJobId(TENANT, id);

    await evaluateGoal(TENANT, id, { snapshotRef: 'ref:final', snapshotHash: 'hf' });
    expect((await getJob(jobId))?.enabled).toBe(false);
    await processDueSchedules(deps, SLOT_1);
    expect((await goalRuns(jobId)).length).toBe(0);
  });

  it('abandon disarms too', async () => {
    const id = await makeScheduleGoal();
    await armContinuation(TENANT, id, { workflowId: 'wf:checkpoint', cronExpr: '0 * * * *' });
    await transitionGoal(TENANT, id, 'abandon');
    expect((await getJob(continuationJobId(TENANT, id)))?.enabled).toBe(false);
  });
});
