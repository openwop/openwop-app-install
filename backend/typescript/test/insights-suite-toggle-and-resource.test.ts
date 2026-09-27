/**
 * INS-3 / INS-4 — Insights Suite toggle gating + parameterizable Workday resource.
 *
 * INS-3 (REWRITTEN by ADR 0599 §6). This suite used to assert `teardownAllSchedules` and
 * its toggle-status listener: on a GLOBAL flip to `off`, delete every tenant's job. That
 * mechanism is gone, because it was backwards in both directions at once — it deleted the
 * jobs of tenants the same request had explicitly KEPT enabled via `tenantOverrides`, and
 * it fired for NONE of the three narrowings that are not a global `→ off` (including
 * `tenantOverrides[t]={status:'off'}`, the only per-tenant disable that exists), leaving
 * those tenants' crons firing for a feature explicitly off for them.
 *
 * The suite covered only the one transition that worked. It is now driven through the REAL
 * `processDueSchedules` daemon and the REAL ingest path, and it asserts the two directions
 * the old one could not: a per-tenant override stops the fire, and the job ROW SURVIVES so
 * re-enabling resumes without a config re-save.
 *
 * INS-4: the anniversary workflow's Workday resource is parameterizable via the
 *   `workdayResource` variable (wired to the node's `resource` input, which overrides the
 *   `serviceDates` config default), instead of being hard-coded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetTriggerBridgeStore, getSubscription } from '../src/host/triggerBridgeService.js';
import { getJob, resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { ingestExternalEvent } from '../src/host/triggerIngestionService.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { saveConfig, __clearToggleStore, resolveOne } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { insightsSuiteFeature } from '../src/features/insights-suite/feature.js';
import type { ToggleConfig, FeatureToggleStatus } from '../src/host/featureToggles/types.js';
import { buildInsightsMetaWorkflow, ANNIVERSARY_DRAFT_ID } from '../src/features/insights-suite/metaWorkflows.js';
import {
  loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

// ADR 0472 P2 — the anniversary meta-workflow migrated to a chain pack; build the MIGRATED def.
_resetChainRegistryForTest();
loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
const anniversaryDraftDefinition = buildInsightsMetaWorkflow(ANNIVERSARY_DRAFT_ID);

// A minimal valid insights-suite toggle config (the feature's real toggleDefault registers
// only when the feature package loads; this unit test builds the literal directly).
const toggle = (status: FeatureToggleStatus): ToggleConfig =>
  ({ id: 'insights-suite', status, bucketUnit: 'tenant', salt: 'insights-suite' });
import {
  applyConfig, weeklyScheduleJobId, anniversaryTriggerSubscriptionId,
  __resetInsightsSuiteStore, type InsightsSuiteConfig,
} from '../src/features/insights-suite/insightsSuiteService.js';

const cfg = (over: Partial<InsightsSuiteConfig> = {}): InsightsSuiteConfig => ({
  tenantId: 't1', principalUserId: 'u-ceo', businessUnits: ['TX'],
  scheduleCron: '0 6 * * 1', anniversaryTriggerEnabled: true,
  planSource: { projectId: 'acme-analytics' },
  updatedAt: new Date().toISOString(), ...over,
});

/** A toggle config with a per-tenant override — the narrowing the old listener missed. */
const toggleWithOverride = (status: FeatureToggleStatus, overrides: Record<string, { status: FeatureToggleStatus }>): ToggleConfig =>
  ({ ...toggle(status), tenantOverrides: overrides });

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

describe('INS-3 (ADR 0599 §6) — the owning-feature gate fires PER TENANT, at fire/ingest time', () => {
  const storage = openSqliteStorage(':memory:');
  let deps: StartRunDeps;
  beforeAll(() => {
    initHostExtPersistence(storage);
    // ANTI-VACUITY. `getEffectiveConfig` returns null when the id has no REGISTERED
    // DEFAULT, and `resolveOne` then answers null, which the fire-time gate reads as
    // "not enabled" — correctly, and fail-closed. But it means an unregistered toggle
    // makes every OFF assertion in this suite pass for the wrong reason. Registering
    // the feature's real `toggleDefault` is what forces the ON case to be reachable,
    // and the ON case is what proves the OFF cases are measuring the gate.
    registerToggleDefault(insightsSuiteFeature.toggleDefault!);
  });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetTriggerBridgeStore();
    await __resetInsightsSuiteStore();
    await __clearToggleStore();
    // The job store is DURABLE and this describe shares one storage handle, so a
    // job left by a previous case fires here and inflates the daemon's return
    // count. That inflation is exactly what made the per-tenant-OFF case read
    // green while measuring nothing.
    await resetScheduling();
    deps = { storage, hostSuite };
  });

  it('the toggle actually RESOLVES in this suite (else every OFF assertion is vacuous)', async () => {
    await saveConfig(toggle('on'), 'test');
    expect((await resolveOne('insights-suite', { tenantId: 't-on' }))?.enabled).toBe(true);
    await saveConfig(toggleWithOverride('on', { 't-off': { status: 'off' } }), 'test');
    expect((await resolveOne('insights-suite', { tenantId: 't-off' }))?.enabled).toBe(false);
  });

  /** How many runs the daemon started for this job, read off the durable run rows. */
  async function firedRuns(jobId: string): Promise<number> {
    const runs = await storage.listRuns({ limit: 200 });
    return runs.filter((r) => ((r.metadata as Record<string, unknown>)?.schedule as Record<string, unknown> | undefined)?.jobId === jobId).length;
  }
  /** `applyConfig` registers against the real clock, and the cron is weekly
   *  (`0 6 * * 1`), so `nextFireAt` is always within 7 days of registration.
   *  Polling 8 days ahead makes the job unconditionally due — the daemon has to
   *  CONSIDER it before any gate can be observed to skip it. */
  const dueNow = (): number => Date.now() + 8 * 24 * 60 * 60 * 1000;

  it('stamps featureId on BOTH reconciled primitives', async () => {
    const c = cfg();
    await applyConfig(c);
    expect((await getJob(weeklyScheduleJobId(c)))?.featureId).toBe('insights-suite');
    expect((await getSubscription(anniversaryTriggerSubscriptionId(c)))?.featureId).toBe('insights-suite');
  });

  it('a per-tenant override to OFF stops the fire — the direction the old listener missed ENTIRELY', async () => {
    // Global ON, this tenant explicitly OFF. The retired listener fired on a change
    // to the global `status` field only, so this narrowing tore down nothing and the
    // tenant's cron kept firing for a feature explicitly disabled for them.
    await saveConfig(toggleWithOverride('on', { 't-off': { status: 'off' } }), 'test');
    const c = cfg({ tenantId: 't-off' });
    await applyConfig(c);
    const jobId = weeklyScheduleJobId(c);

    expect(await processDueSchedules(deps, dueNow())).toBe(0);
    expect(await firedRuns(jobId)).toBe(0);
    // NON-DESTRUCTIVE: the row survives, so re-enabling resumes with no config re-save.
    // The retired teardown hard-DELETED it and documented that recovery was manual.
    const job = await getJob(jobId);
    expect(job, 'the gate must not destroy the schedule').not.toBeNull();
    expect(job?.lastSkipReason).toBe('feature-disabled');
  });

  it('a GLOBAL off does not fire, and does not touch a tenant kept enabled by an override', async () => {
    // The blast-radius half: an operator staging a rollback that deliberately keeps
    // one tenant live. The retired teardown ran a repo-GLOBAL `configs.list()` and
    // deleted `t-vip`'s job anyway, while `resolveConfig` still reported it enabled.
    await saveConfig(toggleWithOverride('off', { 't-vip': { status: 'on' } }), 'test');
    const off = cfg({ tenantId: 't-global-off' });
    const vip = cfg({ tenantId: 't-vip' });
    await applyConfig(off);
    await applyConfig(vip);

    expect(await processDueSchedules(deps, dueNow())).toBe(1);
    expect(await firedRuns(weeklyScheduleJobId(off))).toBe(0);
    // ADR 0599 §Correction 7 — THE POSITIVE HALF, which this test did not have.
    // Every assertion here used to be negative or structural: nothing fired for
    // `t-global-off`, and `t-vip`'s row + subscription still EXIST. Sabotaging the
    // gate to `if (true)` (block unconditionally) left this case GREEN while a
    // sibling correctly reddened — so the scenario §6 headlines, "an operator
    // staging a rollback that deliberately keeps one tenant live", was the one
    // scenario with no witness. A surviving row is not a firing schedule.
    expect(
      await firedRuns(weeklyScheduleJobId(vip)),
      'the exempt tenant must actually FIRE — a schedule that survives but never runs is the same outage the teardown caused',
    ).toBe(1);
    expect(await getJob(weeklyScheduleJobId(vip)), 'the exempt tenant\'s schedule must survive').not.toBeNull();
    expect((await getSubscription(anniversaryTriggerSubscriptionId(vip)))?.state).toBe('active');
  });

  it('with the feature ON for the tenant the job DOES fire — the gate is not vacuous', async () => {
    await saveConfig(toggle('on'), 'test');
    const c = cfg({ tenantId: 't-on' });
    await applyConfig(c);
    expect(await processDueSchedules(deps, dueNow())).toBe(1);
    expect(await firedRuns(weeklyScheduleJobId(c))).toBe(1);
  });

  it('the scheduled fire carries the inputs the chain needs — planSource was read by NOTHING before', async () => {
    const c = cfg();
    await applyConfig(c);
    expect((await getJob(weeklyScheduleJobId(c)))?.inputs).toEqual({ projectId: 'acme-analytics', businessUnit: 'TX' });
  });

  it('trigger ingest is gated the same way — a disabled tenant\'s webhook starts no run', async () => {
    await saveConfig(toggleWithOverride('on', { 't-ingest': { status: 'off' } }), 'test');
    const c = cfg({ tenantId: 't-ingest' });
    await applyConfig(c);
    const res = await ingestExternalEvent(
      { storage, hostSuite } as unknown as Parameters<typeof ingestExternalEvent>[0],
      anniversaryTriggerSubscriptionId(c),
      { source: 'webhook', rawBody: JSON.stringify({ subjectId: 'subj-42', milestone: '10 years' }) } as Parameters<typeof ingestExternalEvent>[2],
    );
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toBe('feature-disabled');
    expect(res.runId).toBeUndefined();
  });
});

describe('INS-4 — anniversary workflow parameterizes the Workday resource', () => {
  it('declares a workdayResource variable (default serviceDates) wired to the node resource input', () => {
    const v = anniversaryDraftDefinition.variables?.find((x) => x.name === 'workdayResource');
    expect(v).toBeDefined();
    expect(v?.defaultValue).toBe('serviceDates');

    // expandChain prefixes node ids; the milestones node is the sole core.workday.query.
    const node = anniversaryDraftDefinition.nodes.find((n) => n.typeId === 'core.workday.query');
    // The node still carries the serviceDates config default (no-regression fallback)...
    expect((node?.config as { resource?: string } | undefined)?.resource).toBe('serviceDates');
    // ...and wires the variable to its `resource` input so a run can override it.
    expect((node?.inputs as Record<string, unknown> | undefined)?.resource)
      .toEqual({ type: 'variable', variableName: 'workdayResource' });
  });
});
