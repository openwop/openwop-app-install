/**
 * ADR 0821 D6 (+ architect #1) / P5 — the durable monthly `workflowRuns` limit,
 * enforced at `host/runStarter.ts` `startWorkflowRun`.
 *
 * Pins:
 *   1. a limited tenant runs up to the limit and the next start is a typed 429
 *      `plan_run_limit_reached` (positive control: the runs under it are served);
 *   2. a REFUSED launch never consumes a run (ADR 0823 ordering): an unresolved
 *      workflow and an approve-what-you-see hash mismatch leave the count at 0;
 *   3. re-presenting a deterministic run id (an idempotent replay) never counts;
 *   4. no limit configured ⇒ nothing counted (today's behaviour);
 *   5. THE WITNESS (architect #1): an `OPENWOP_BILLING_EXEMPT_TENANTS` tenant passes
 *      the run limit AND is still plan-refused on a priced feature — the exemption
 *      covers limits and credits, never the paywall.
 *
 * Runs through billing's REAL plan-limits resolver (`billingPlanLimitsResolver`),
 * so the toggle + entitlement path is the production one.
 *
 * Tracker TST-BUL-8. Sabotage-witnessed (w62): red when the limit admits one run
 * too many, a refused or replayed launch reserves a run, the exemption is
 * ignored, an absent limit counts as zero, or the exemption leaks into the
 * paywall.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerPlanLimitsResolver } from '../src/host/planLimitsSeam.js';
import { planRunsThisMonth } from '../src/host/planRunLimit.js';
import { billingPlanLimitsResolver } from '../src/features/billing/feature.js';
import { requireEntitledFeatureForTenant } from '../src/features/billing/entitlementGuard.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { definitionHashOf } from '../src/host/definitionHash.js';

const WF = { workflowId: 'wf-1', nodes: [] };
const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => (id === 'wf-1' ? { workflowId: id, definition: WF } : null) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  deps = { storage, hostSuite };
  registerToggleDefault({ id: 'billing', label: 'Billing', description: 'b', status: 'on', bucketUnit: 'tenant', salt: 'billing' });
  registerPlanLimitsResolver(billingPlanLimitsResolver);
  process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { workflowRuns: 2 } });
});
afterEach(() => {
  registerPlanLimitsResolver(null);
  for (const k of ['OPENWOP_BILLING_PLAN_LIMITS', 'OPENWOP_BILLING_EXEMPT_TENANTS', 'OPENWOP_BILLING_PLAN_FEATURES']) delete process.env[k];
  __resetHostExtPersistence();
});

describe('ADR 0821 D6 — the monthly workflowRuns limit at startWorkflowRun', () => {
  it('serves runs up to the limit, then refuses with a typed 429', async () => {
    expect(await startWorkflowRun(deps, { tenantId: 't-lim', workflowId: 'wf-1' })).toBeTruthy();
    expect(await startWorkflowRun(deps, { tenantId: 't-lim', workflowId: 'wf-1' })).toBeTruthy();
    await expect(startWorkflowRun(deps, { tenantId: 't-lim', workflowId: 'wf-1' })).rejects.toMatchObject({
      httpStatus: 429, details: { reason: 'plan_run_limit_reached', limit: 2 },
    });
    expect(await planRunsThisMonth('t-lim')).toBe(2);
  });

  it('a REFUSED launch never consumes a run (unresolved workflow, hash mismatch)', async () => {
    expect(await startWorkflowRun(deps, { tenantId: 't-ref', workflowId: 'wf-missing' })).toBeNull();
    expect(await startWorkflowRun(deps, { tenantId: 't-ref', workflowId: 'wf-1', expectedDefinitionHash: 'not-the-hash' })).toBeNull();
    expect(await planRunsThisMonth('t-ref')).toBe(0);
    // Positive control: a matching hash IS a launch and IS counted.
    expect(await startWorkflowRun(deps, { tenantId: 't-ref', workflowId: 'wf-1', expectedDefinitionHash: definitionHashOf(WF) })).toBeTruthy();
    expect(await planRunsThisMonth('t-ref')).toBe(1);
  });

  it('re-presenting a deterministic run id (a replay) is not a second run', async () => {
    const id = await startWorkflowRun(deps, { tenantId: 't-idem', workflowId: 'wf-1', runId: 'run-fixed-1' });
    expect(await startWorkflowRun(deps, { tenantId: 't-idem', workflowId: 'wf-1', runId: 'run-fixed-1' })).toBe(id);
    expect(await planRunsThisMonth('t-idem')).toBe(1);
  });

  it('no limit configured ⇒ nothing counted, nothing refused (today)', async () => {
    delete process.env.OPENWOP_BILLING_PLAN_LIMITS;
    for (let i = 0; i < 4; i += 1) expect(await startWorkflowRun(deps, { tenantId: 't-free', workflowId: 'wf-1' })).toBeTruthy();
    expect(await planRunsThisMonth('t-free')).toBe(0);
  });
});

describe('ADR 0821 architect #1 — the exemption covers limits, NEVER the paywall', () => {
  it('an exempt tenant passes the run limit AND is still plan-refused on a priced feature', async () => {
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = JSON.stringify(['conformance-prod']);
    // A narrowed plan: `webinars` (a priced bundle feature) is not in the free plan.
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
    for (let i = 0; i < 4; i += 1) expect(await startWorkflowRun(deps, { tenantId: 'conformance-prod', workflowId: 'wf-1' })).toBeTruthy();
    expect(await planRunsThisMonth('conformance-prod')).toBe(0);
    await expect(requireEntitledFeatureForTenant('conformance-prod', 'webinars')).rejects.toMatchObject({ httpStatus: 403, code: 'forbidden', message: expect.stringContaining('does not include this feature') });

    // Positive controls: a non-exempt tenant IS run-limited, and the paywall
    // verdict is identical for it — the exemption changed only the limit.
    await startWorkflowRun(deps, { tenantId: 't-ctl', workflowId: 'wf-1' });
    await startWorkflowRun(deps, { tenantId: 't-ctl', workflowId: 'wf-1' });
    await expect(startWorkflowRun(deps, { tenantId: 't-ctl', workflowId: 'wf-1' })).rejects.toMatchObject({ httpStatus: 429 });
    await expect(requireEntitledFeatureForTenant('t-ctl', 'webinars')).rejects.toMatchObject({ httpStatus: 403, code: 'forbidden', message: expect.stringContaining('does not include this feature') });
    await expect(requireEntitledFeatureForTenant('conformance-prod', 'billing')).resolves.toBeUndefined();
  });
});
