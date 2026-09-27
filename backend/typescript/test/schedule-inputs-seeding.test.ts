/**
 * A scheduled job must be able to carry PER-FIRE INPUTS.
 *
 * `ScheduledJob` had `metadata` and `configurable` but no `inputs`, and the
 * daemon forwarded neither — so a workflow that declares `variables[]` fired on
 * a schedule with those variables UNDEFINED. The KickTodo daily loop declares
 * `enrollmentId`/`ownerSubject` and its nodes read `input('enrollmentId')`, so
 * every scheduled tick ran against no enrollment: the participant loop the
 * B4/B5 remediation claimed to have made runtime-executable was inert.
 *
 * These assert the seam end-to-end: a job registered WITH inputs fires a run
 * whose `inputs` carry them, and a job without inputs still fires (additive,
 * back-compatible).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerJob, resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

const T0 = Date.parse('2026-06-02T10:15:00Z'); // hourly → next slot 11:00Z
const FIRE = Date.parse('2026-06-02T11:05:00Z');

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await resetScheduling();
  deps = { storage, hostSuite };
});
afterEach(() => __resetHostExtPersistence());

async function runsFor(jobId: string) {
  const runs = await storage.listRuns({ limit: 100 });
  return runs.filter((r) => (((r.metadata as Record<string, unknown>)?.schedule as Record<string, unknown>)?.jobId) === jobId);
}

describe('scheduled-job per-fire inputs', () => {
  it('seeds the fired run with the job inputs', async () => {
    await registerJob(
      { jobId: 'daily', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'openwop-app.kicktodo.daily-loop',
        timezone: 'UTC', inputs: { enrollmentId: 'enr:abc', ownerSubject: 'user:coach' } },
      T0,
    );
    await processDueSchedules(deps, FIRE);

    const fired = await runsFor('daily');
    expect(fired).toHaveLength(1);
    // This is the assertion that was impossible to satisfy before: the
    // enrollment identity the daily loop's nodes read is actually present.
    expect(fired[0]!.inputs).toEqual({ enrollmentId: 'enr:abc', ownerSubject: 'user:coach' });
  });

  it('still fires a job that carries no inputs (additive, back-compatible)', async () => {
    await registerJob({ jobId: 'plain', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-x', timezone: 'UTC' }, T0);
    await processDueSchedules(deps, FIRE);
    const fired = await runsFor('plain');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.inputs ?? null).toBeNull();
  });
});
