/**
 * ADR 0820 §7 / strategy G6 + G7 — the run-start gate by OWNING FEATURE, the
 * schedule LAPSE auto-pause, and the projected compute-node tools.
 *
 * Every refusal here has a POSITIVE control (an entitled tenant is served), so a
 * gate that blocks everything cannot pass. The plan is simulated with the real
 * tenant entitlement seam (`registerTenantEntitlementCheck`), and `insights-suite`
 * is a real sellable bundle feature (agents bundle) with its real toggle default.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import type { ToggleConfig } from '../src/host/featureToggles/types.js';
import { OpenwopError } from '../src/types.js';
import { resolveLaunchWorkflow } from '../src/host/resolveLaunchDefinition.js';
import { resolveRunDefinition } from '../src/host/resolveRunDefinition.js';
import {
  registerWorkflowFeature, WorkflowFeatureRefusedError, _resetWorkflowFeaturesForTest,
} from '../src/host/workflowFeatureGate.js';
import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import { getJob, registerJob, resetScheduling, setJobEnabled, type ScheduledJob } from '../src/host/schedulingService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { planLapsedFeature } from '../src/host/schedulePlanLapse.js';
import { ingestExternalEvent } from '../src/host/triggerIngestionService.js';
import { getSubscription, registerSubscription } from '../src/host/triggerBridgeService.js';
import { processDueSchedules, resumePlanPausedJobs } from '../src/host/scheduleDaemon.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { registerRunLimitReserver, withRunLimit } from '../src/host/runLimitSeam.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const FEATURE = 'insights-suite';
const PAID_WF = 'wf.test.paid-feature';
const PAID_CHAIN = 'test-chain.paid';
const FREE_WF = 'wf.test.unowned';

const toggle = (over: Partial<ToggleConfig> = {}): ToggleConfig =>
  ({ id: FEATURE, status: 'on', bucketUnit: 'tenant', salt: FEATURE, ...over });

/** Tenants named `lapsed*` are refused by the plan; everyone else is entitled. */
function installPlan(): void {
  registerTenantEntitlementCheck(async (tenantId, featureId) => {
    if (tenantId.startsWith('lapsed')) throw new OpenwopError('forbidden', `plan excludes ${featureId}`, 403, { feature: featureId });
  });
}

const def = (workflowId: string, metadata?: Record<string, unknown>): WorkflowDefinition =>
  ({ workflowId, nodes: [], ...(metadata ? { metadata } : {}) } as WorkflowDefinition);

const catalog = {
  getWorkflow: async (id: string) => {
    if (id === 'wf.tenant-copy') return { workflowId: id, definition: def(id, { expandedFrom: { chainId: PAID_CHAIN, version: '1', params: {} } }) };
    return { workflowId: id, definition: def(id) };
  },
};

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: catalog,
  providerPolicyResolver: { resolveForRun: async () => [] },
};

const storage = openSqliteStorage(':memory:');
const deps: StartRunDeps = { storage, hostSuite };

beforeAll(() => {
  initHostExtPersistence(storage);
  registerToggleDefault({ id: FEATURE, status: 'on', bucketUnit: 'tenant', salt: FEATURE });
});
afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
beforeEach(async () => {
  initHostExtPersistence(storage);
  await __clearToggleStore();
  await saveConfig(toggle(), 'test');
  await resetScheduling();
  _resetWorkflowFeaturesForTest();
  registerWorkflowFeature(PAID_WF, FEATURE);
  registerWorkflowFeature(PAID_CHAIN, FEATURE);
  installPlan();
  registerRunLimitReserver(null);
});

async function runsFor(workflowId: string): Promise<RunRecord[]> {
  return (await storage.listRuns({ limit: 500 })).filter((r) => r.workflowId === workflowId);
}

describe('G6 — the launch funnel refuses a feature-owned workflow the tenant may not use', () => {
  it('POSITIVE: an entitled tenant resolves the paid workflow', async () => {
    const wf = await resolveLaunchWorkflow(catalog, 'acme', PAID_WF);
    expect(wf?.workflowId).toBe(PAID_WF);
  });

  it('a plan-lapsed tenant gets the TYPED refusal (403, not_entitled), never a not-found', async () => {
    const err = await resolveLaunchWorkflow(catalog, 'lapsed-1', PAID_WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFeatureRefusedError);
    const r = err as WorkflowFeatureRefusedError;
    expect(r.httpStatus).toBe(403);
    expect(r.blockedBy).toBe('plan');
    expect(r.details).toMatchObject({ feature: FEATURE, reason: 'not_entitled', workflowId: PAID_WF });
  });

  it('a toggle switched OFF for the tenant is refused as feature_disabled (distinct from the plan)', async () => {
    await saveConfig(toggle({ tenantOverrides: { 'acme-off': { status: 'off' } } }), 'test');
    const err = await resolveLaunchWorkflow(catalog, 'acme-off', PAID_WF).catch((e: unknown) => e);
    expect((err as WorkflowFeatureRefusedError).blockedBy).toBe('toggle');
    expect((err as WorkflowFeatureRefusedError).details?.reason).toBe('feature_disabled');
  });

  it('a workflow NO feature owns is never refused, even for a lapsed tenant', async () => {
    expect((await resolveLaunchWorkflow(catalog, 'lapsed-1', FREE_WF))?.workflowId).toBe(FREE_WF);
  });

  it('a tenant COPY minted from a feature chain inherits the gate (expandedFrom.chainId)', async () => {
    await expect(resolveLaunchWorkflow(catalog, 'lapsed-1', 'wf.tenant-copy')).rejects.toBeInstanceOf(WorkflowFeatureRefusedError);
    expect((await resolveLaunchWorkflow(catalog, 'acme', 'wf.tenant-copy'))?.workflowId).toBe('wf.tenant-copy');
  });

  it('the listed operator\'s planExempt subject is served (the ADR 0819 person-level exemption)', async () => {
    expect((await resolveLaunchWorkflow(catalog, 'lapsed-1', PAID_WF, { subject: { planExempt: true } }))?.workflowId).toBe(PAID_WF);
  });

  it('a RELAUNCH (:fork, redrive) is gated; a continuation (resume) is not', async () => {
    const run = { runId: 'r1', tenantId: 'lapsed-1', workflowId: PAID_WF, metadata: {} } as unknown as RunRecord;
    await expect(resolveRunDefinition(run, catalog, { relaunch: { operator: false } })).rejects.toBeInstanceOf(WorkflowFeatureRefusedError);
    expect((await resolveRunDefinition(run, catalog))?.definition.workflowId).toBe(PAID_WF);
    const ok = { ...run, tenantId: 'acme' } as RunRecord;
    expect((await resolveRunDefinition(ok, catalog, { relaunch: { operator: false } }))?.definition.workflowId).toBe(PAID_WF);
  });
});

describe('G6 — a refused launch consumes nothing', () => {
  it('startWorkflowRun throws the typed refusal and inserts NO run; the entitled tenant gets one', async () => {
    await expect(startWorkflowRun(deps, { tenantId: 'lapsed-2', workflowId: PAID_WF })).rejects.toBeInstanceOf(WorkflowFeatureRefusedError);
    expect((await runsFor(PAID_WF)).filter((r) => r.tenantId === 'lapsed-2')).toHaveLength(0);
    const runId = await startWorkflowRun(deps, { tenantId: 'acme-2', workflowId: PAID_WF });
    expect(runId).toBeTruthy();
    expect((await runsFor(PAID_WF)).filter((r) => r.tenantId === 'acme-2')).toHaveLength(1);
  });
});

describe('ADR 0820 §7 — schedule LAPSE auto-pause (a COMPUTED skip) and automatic resume', () => {
  // The pause is computed at tick time: the job row is never disabled and no
  // paused flag is written, so re-entitlement resumes it on the very next tick
  // with no sweep and no manual step. These pin that the schedule's CONFIG is
  // untouched by a lapse — only the daemon's slot/skip bookkeeping moves.
  const dueAt = (hours: number): number => Date.now() + hours * 60 * 60 * 1000;
  const BOOKKEEPING = ['nextFireAt', 'lastSkippedAt', 'lastSkipReason', 'lastSkipFeatureId', 'lastRunId', 'lastRunAt', 'lastFiredTick'] as const;
  const configOf = (job: ScheduledJob | null): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...(job ?? {}) };
    for (const k of BOOKKEEPING) delete out[k];
    return out;
  };
  async function hourlyJob(jobId: string, tenantId: string, opts: { featureId?: string; workflowId?: string } = {}): Promise<void> {
    const res = await registerJob({
      jobId, tenantId, cronExpr: '0 * * * *', workflowId: opts.workflowId ?? PAID_WF, timezone: 'Europe/Paris',
      inputs: { enrollmentId: 'e-1' }, metadata: { note: 'keep me' },
      ...(opts.featureId ? { featureId: opts.featureId } : {}),
    });
    expect(res.ok).toBe(true);
  }
  const runsOf = async (tenantId: string): Promise<RunRecord[]> => (await runsFor(PAID_WF)).filter((r) => r.tenantId === tenantId);

  it('POSITIVE: an entitled tenant\'s job fires and stays enabled', async () => {
    await hourlyJob('j-ok', 'acme-s', { featureId: FEATURE });
    expect(await processDueSchedules(deps, dueAt(2))).toBe(1);
    const job = await getJob('j-ok');
    expect(job?.enabled).toBe(true);
    expect(job?.lastSkipReason).toBeUndefined();
  });

  it('a PLAN refusal is skipped as plan-lapsed: no run (failed or otherwise), the row stays ENABLED and its config is untouched', async () => {
    await hourlyJob('j-lapsed', 'lapsed-s', { featureId: FEATURE });
    const before = configOf(await getJob('j-lapsed'));
    expect(await processDueSchedules(deps, dueAt(2))).toBe(0);
    expect(await processDueSchedules(deps, dueAt(3))).toBe(0); // a second tick: still quiet
    const job = await getJob('j-lapsed');
    expect(job?.enabled).toBe(true);
    expect(job?.planPause).toBeUndefined();
    expect(job?.lastSkipReason).toBe('plan-lapsed');
    expect(job?.lastSkipFeatureId).toBe(FEATURE);
    expect(configOf(job)).toEqual(before);
    expect(await runsOf('lapsed-s')).toHaveLength(0);
  });

  it('a TOGGLE switched off is NOT a lapse: it stays the distinct feature-disabled skip', async () => {
    await saveConfig(toggle({ tenantOverrides: { 'acme-toggle-off': { status: 'off' } } }), 'test');
    await hourlyJob('j-off', 'acme-toggle-off', { featureId: FEATURE });
    expect(await processDueSchedules(deps, dueAt(2))).toBe(0);
    const job = await getJob('j-off');
    expect(job?.enabled).toBe(true);
    expect(job?.lastSkipReason).toBe('feature-disabled');
    expect(job?.lastSkipFeatureId).toBeUndefined();
  });

  it('backfill-on-read: a job with NO featureId is skipped through its workflow\'s owning feature', async () => {
    await hourlyJob('j-legacy', 'lapsed-legacy');
    expect((await getJob('j-legacy'))?.featureId).toBeUndefined();
    expect(await processDueSchedules(deps, dueAt(2))).toBe(0);
    const job = await getJob('j-legacy');
    expect(job?.enabled).toBe(true);
    expect(job?.lastSkipReason).toBe('plan-lapsed');
    expect(job?.lastSkipFeatureId).toBe(FEATURE);
  });

  it('RE-GRANT resumes on the NEXT tick with no sweep and no manual step, restoring the exact prior schedule config', async () => {
    await hourlyJob('j-resume', 'lapsed-r', { featureId: FEATURE });
    await hourlyJob('j-still', 'lapsed-still', { featureId: FEATURE });
    const before = configOf(await getJob('j-resume'));
    await processDueSchedules(deps, dueAt(2));
    expect((await getJob('j-resume'))?.lastSkipReason).toBe('plan-lapsed');
    // Re-entitle ONE tenant. Nothing else is called: no resume sweep, no PATCH.
    registerTenantEntitlementCheck(async (tenantId, featureId) => {
      if (tenantId === 'lapsed-still') throw new OpenwopError('forbidden', `plan excludes ${featureId}`, 403, {});
    });
    expect(await processDueSchedules(deps, dueAt(4))).toBe(1);
    const resumed = await getJob('j-resume');
    expect(resumed?.enabled).toBe(true);
    expect(resumed?.lastSkipReason).toBeUndefined();
    expect(resumed?.lastSkipFeatureId).toBeUndefined();
    expect(resumed?.lastRunId).toBeTruthy();
    expect(configOf(resumed)).toEqual(before);
    expect(await runsOf('lapsed-r')).toHaveLength(1);
    // The still-lapsed tenant stays quiet.
    expect((await getJob('j-still'))?.lastSkipReason).toBe('plan-lapsed');
    expect(await runsOf('lapsed-still')).toHaveLength(0);
  });

  it('LEGACY: a row the pre-computed-skip code paused (enabled:false + planPause) is still drained back to enabled by the sweep', async () => {
    // #4436 persisted the pause; rows it wrote before this change must not stay
    // stranded. Written raw, exactly as that code left them.
    await hourlyJob('j-legacy-paused', 'lapsed-lp', { featureId: FEATURE });
    const raw = new DurableCollection<ScheduledJob>('scheduler:job', (j) => j.jobId);
    const row = (await raw.get('j-legacy-paused'))!;
    await raw.put({ ...row, enabled: false, planPause: { reason: 'plan_lapsed', featureId: FEATURE, at: new Date().toISOString() } });
    registerTenantEntitlementCheck(async () => undefined);
    expect(await resumePlanPausedJobs([(await getJob('j-legacy-paused'))!], Date.now(), true)).toBe(1);
    const job = await getJob('j-legacy-paused');
    expect(job?.enabled).toBe(true);
    expect(job?.planPause).toBeUndefined();
  });

  it('a person\'s explicit DISABLE of a legacy-paused row wins: the sweep never re-enables it', async () => {
    await hourlyJob('j-user-off', 'lapsed-u', { featureId: FEATURE });
    const raw = new DurableCollection<ScheduledJob>('scheduler:job', (j) => j.jobId);
    const row = (await raw.get('j-user-off'))!;
    await raw.put({ ...row, enabled: false, planPause: { reason: 'plan_lapsed', featureId: FEATURE, at: new Date().toISOString() } });
    await setJobEnabled('j-user-off', false);
    expect((await getJob('j-user-off'))?.planPause).toBeUndefined();
    registerTenantEntitlementCheck(async () => undefined);
    expect(await resumePlanPausedJobs([(await getJob('j-user-off'))!], Date.now(), true)).toBe(0);
    expect((await getJob('j-user-off'))?.enabled).toBe(false);
  });

  it('planLapsedFeature: names the feature while the plan refuses it, and nothing once access returns or for a toggle-off skip', async () => {
    await hourlyJob('j-chip', 'lapsed-chip', { featureId: FEATURE });
    await processDueSchedules(deps, dueAt(2));
    expect(await planLapsedFeature((await getJob('j-chip'))!)).toBe(FEATURE);
    registerTenantEntitlementCheck(async () => undefined);
    expect(await planLapsedFeature((await getJob('j-chip'))!)).toBeNull();
  });
});

describe('ADR 0820 §7 — a TRIGGER on a plan-lapsed feature skips as plan-lapsed (the schedule daemon\'s twin)', () => {
  // Ingest is a computed skip already; only the LABEL was wrong: a plan lapse
  // read `feature-disabled`, the same as a kill switch. Every leg has a control.
  const ingest = (subscriptionId: string) => ingestExternalEvent(
    deps as unknown as Parameters<typeof ingestExternalEvent>[0], subscriptionId,
    { source: 'webhook', rawBody: JSON.stringify({ hello: 'world' }) } as Parameters<typeof ingestExternalEvent>[2],
  );
  async function sub(subscriptionId: string, tenantId: string, opts: { featureId?: string }): Promise<void> {
    await registerSubscription({ subscriptionId, tenantId, source: 'webhook', workflowId: PAID_WF, ...(opts.featureId ? { featureId: opts.featureId } : {}) });
  }

  it('a subscription whose featureId the PLAN refuses skips with reason plan-lapsed and starts no run', async () => {
    await sub('s-lapsed', 'lapsed-t', { featureId: FEATURE });
    expect(await ingest('s-lapsed')).toEqual({ outcome: 'skipped', reason: 'plan-lapsed' });
    expect((await runsFor(PAID_WF)).filter((r) => r.tenantId === 'lapsed-t')).toHaveLength(0);
    expect((await getSubscription('s-lapsed'))?.state).toBe('active');
  });

  it('a subscription with NO featureId is refused through its workflow\'s owning feature, also as plan-lapsed', async () => {
    await sub('s-lapsed-wf', 'lapsed-wf', {});
    expect(await ingest('s-lapsed-wf')).toEqual({ outcome: 'skipped', reason: 'plan-lapsed' });
  });

  it('a TOGGLE switched off is NOT a lapse: it stays feature-disabled (both gates)', async () => {
    await saveConfig(toggle({ tenantOverrides: { 'acme-trig-off': { status: 'off' }, 'acme-trig-off-wf': { status: 'off' } } }), 'test');
    await sub('s-off', 'acme-trig-off', { featureId: FEATURE });
    await sub('s-off-wf', 'acme-trig-off-wf', {});
    expect(await ingest('s-off')).toEqual({ outcome: 'skipped', reason: 'feature-disabled' });
    expect(await ingest('s-off-wf')).toEqual({ outcome: 'skipped', reason: 'feature-disabled' });
  });

  it('POSITIVE: an entitled tenant\'s subscription is not skipped', async () => {
    await sub('s-ok', 'acme-trig', { featureId: FEATURE });
    const res = await ingest('s-ok');
    expect(res.outcome).not.toBe('skipped');
  });
});

describe('G7 — projected compute-node chat tools resolve their owning feature', () => {
  const tool = (): NonNullable<ReturnType<typeof builtinAgentTool>> => builtinAgentTool('openwop:feature.insights-suite.nodes.variance-compute')!;

  it('a plan-lapsed tenant gets the typed not_entitled refusal and the node never runs', async () => {
    const out = await tool().run({}, { tenantId: 'lapsed-tool' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('not_entitled');
  });

  it('POSITIVE: an entitled tenant passes the gate (reaches the node resolution)', async () => {
    const out = await tool().run({}, { tenantId: 'acme-tool' });
    expect(out.content).not.toContain('not_entitled');
    expect(out.content).not.toContain('feature_disabled');
  });

  it('a core.* compute node is never feature-gated', async () => {
    const out = await builtinAgentTool('openwop:core.flow.aggregate-text')!.run({}, { tenantId: 'lapsed-tool' });
    expect(out.content).not.toContain('not_entitled');
  });
});

describe('ADR 0821 P5 follow-up — the run-limit seam', () => {
  it('a no-op until wired: the insert runs', async () => {
    expect(await withRunLimit('t', async () => 'inserted')).toBe('inserted');
  });

  it('a refusing reserver stops the insert; a failed insert releases its reservation', async () => {
    let reserved = 0; let released = 0;
    registerRunLimitReserver(async () => {
      if (reserved >= 1) throw new OpenwopError('rate_limited', 'limit', 429, { reason: 'plan_run_limit_reached' });
      reserved += 1;
      return { release: async () => { released += 1; } };
    });
    await expect(withRunLimit('t', async () => { throw new Error('insert failed'); })).rejects.toThrow('insert failed');
    expect(released).toBe(1);
    let inserted = false;
    await expect(withRunLimit('t', async () => { inserted = true; })).rejects.toMatchObject({ httpStatus: 429 });
    expect(inserted).toBe(false);
  });
});
