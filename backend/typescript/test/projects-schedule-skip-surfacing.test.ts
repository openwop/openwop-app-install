/**
 * WF-PRJ-2 / GEN-PRJ-1 (PROBE-PRJ-6 automated) — a dead project schedule must
 * be VISIBLE through the project view.
 *
 * The daemon honestly records a `workflow-unresolved` fire (`recordJobSkipped`
 * stamps `lastSkippedAt`/`lastSkipReason`, plus `lastRunId` on success), but the
 * projects `toView` used to drop all three — so a typo'd schedule showed
 * enabled, `nextFireAt` advancing, `lastRunAt` forever empty, with no reason and
 * no run link (the ADR 0491 "log the SURFACING" class, fixed on the assistant
 * lane and never transferred). This drives the REAL daemon over a REAL
 * project-owned job and asserts the projection `GET /projects/:id/schedules`
 * returns (the route calls `listProjectSchedules` directly).
 *
 * The view is asserted EQUAL to the daemon's row (not merely truthy), so a
 * projection that fabricates or staleness-copies a value cannot pass.
 * Sabotage-witnessed (grade-tests w13): dropping `lastSkipReason` or
 * `lastSkippedAt` from `toView` reds case 1; dropping `lastRunId` or
 * `lastRunAt` reds case 2.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerJob, getJob, updateJob, resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import { listProjectSchedules } from '../src/features/projects/projectScheduleService.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: {
    // `wf-missing` resolves to null → the daemon's "advanced past slot" skip;
    // `wf-1` resolves so the success half can pin `lastRunId` surfacing too.
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

describe('WF-PRJ-2 — the project schedule view surfaces the daemon record', () => {
  it('a workflow-unresolved skip reaches the project view (reason + when), not just the job row', async () => {
    await registerJob({
      jobId: 'job-project-dead', tenantId: 't1', cronExpr: '0 * * * *',
      workflowId: 'wf-typod', timezone: 'UTC', ownerSubject: projectSubject('p1'),
    }, T0);
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(0);

    // The daemon recorded the outcome on the job row (the honest half that
    // always worked)…
    const job = await getJob('job-project-dead');
    expect(job?.lastSkipReason).toBe('workflow-unresolved');
    expect(job?.lastSkippedAt).toBeTruthy();

    // …and the PROJECT projection no longer erases it (the fix under test).
    const view = (await listProjectSchedules('t1', 'p1')).find((s) => s.jobId === 'job-project-dead');
    expect(view, 'the schedule must be listed for its project').toBeTruthy();
    expect(view?.lastSkipReason, 'toView must surface the skip reason').toBe('workflow-unresolved');
    expect(view?.lastSkippedAt, 'toView must surface when the skip happened').toBe(job?.lastSkippedAt);
  });

  it('a successful fire surfaces lastRunId through the project view (the run-link half)', async () => {
    // Born dead (a typo'd workflow) so a REAL prior skip exists — the clearing
    // claim below can only fail if there was something to clear.
    await registerJob({
      jobId: 'job-project-live', tenantId: 't1', cronExpr: '0 * * * *',
      workflowId: 'wf-typod', timezone: 'UTC', ownerSubject: projectSubject('p2'),
    }, T0);
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(0);
    expect((await getJob('job-project-live'))?.lastSkipReason).toBe('workflow-unresolved');

    // Fixed (workflow only — the cadence is unchanged, so `nextFireAt` is left
    // alone). Fire at the slot the ROW says is next: the skip's slot advance is
    // not a pure function of the fire time, so a hard-coded slot is not either.
    await updateJob('job-project-live', { workflowId: 'wf-1' });
    const nextFireAt = (await getJob('job-project-live'))?.nextFireAt;
    expect(nextFireAt).toBeTypeOf('number');
    expect(await processDueSchedules(deps, nextFireAt! + 30_000)).toBe(1);

    const job = await getJob('job-project-live');
    expect(job?.lastRunId, 'the daemon recorded the run').toBeTruthy();
    const view = (await listProjectSchedules('t1', 'p2')).find((s) => s.jobId === 'job-project-live');
    expect(view?.lastRunAt).toBe(job?.lastRunAt);
    expect(view?.lastRunId, 'toView must surface the run id so the panel can link the run').toBe(job?.lastRunId);
    // The successful fire cleared the prior skip record (recordJobRun deletes it),
    // and the view does not resurrect it.
    expect(job?.lastSkippedAt).toBeUndefined();
    expect(view?.lastSkippedAt).toBeUndefined();
    expect(view?.lastSkipReason).toBeUndefined();
  });
});
