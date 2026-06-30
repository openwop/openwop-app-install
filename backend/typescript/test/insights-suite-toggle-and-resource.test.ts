/**
 * INS-3 / INS-4 — Insights Suite toggle-OFF teardown + parameterizable Workday resource.
 *
 * INS-3: the scheduler doesn't gate on the feature toggle, so a persisted insights schedule
 *   / anniversary subscription would keep firing after the toggle is disabled. The feature
 *   now registers a toggle-status listener that tears them down when `insights-suite` → OFF.
 * INS-4: the anniversary workflow's Workday resource is parameterizable via the
 *   `workdayResource` variable (wired to the node's `resource` input, which overrides the
 *   `serviceDates` config default), instead of being hard-coded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetTriggerBridgeStore, getSubscription } from '../src/host/triggerBridgeService.js';
import { getJob } from '../src/host/schedulingService.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import type { ToggleConfig, FeatureToggleStatus } from '../src/host/featureToggles/types.js';
import { anniversaryDraftDefinition } from '../src/features/insights-suite/metaWorkflows.js';

// A minimal valid insights-suite toggle config (the feature's real toggleDefault registers
// only when the feature package loads; this unit test builds the literal directly).
const toggle = (status: FeatureToggleStatus): ToggleConfig =>
  ({ id: 'insights-suite', status, bucketUnit: 'tenant', salt: 'insights-suite' });
import {
  applyConfig, teardownAllSchedules, weeklyScheduleJobId, anniversaryTriggerSubscriptionId,
  __resetInsightsSuiteStore, type InsightsSuiteConfig,
} from '../src/features/insights-suite/insightsSuiteService.js';

const cfg = (over: Partial<InsightsSuiteConfig> = {}): InsightsSuiteConfig => ({
  tenantId: 't1', principalUserId: 'u-ceo', businessUnits: ['TX'],
  scheduleCron: '0 6 * * 1', anniversaryTriggerEnabled: true,
  updatedAt: new Date().toISOString(), ...over,
});

describe('INS-3 — insights-suite toggle-OFF tears down schedules + subscriptions', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => initHostExtPersistence(storage));
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetTriggerBridgeStore();
    await __resetInsightsSuiteStore();
    await __clearToggleStore();
  });

  it('teardownAllSchedules deletes the job and pauses the subscription', async () => {
    const c = cfg();
    await applyConfig(c);
    expect(await getJob(weeklyScheduleJobId(c))).not.toBeNull();      // armed
    expect((await getSubscription(anniversaryTriggerSubscriptionId(c)))?.state).toBe('active');

    const tenants = await teardownAllSchedules();
    expect(tenants).toBe(1);
    expect(await getJob(weeklyScheduleJobId(c))).toBeNull();          // job deleted
    expect((await getSubscription(anniversaryTriggerSubscriptionId(c)))?.state).toBe('paused');
  });

  it('flipping the toggle to OFF triggers teardown via the registered listener', async () => {
    await saveConfig(toggle('on'), 'test'); // enable (prev → on; not a teardown)
    const c = cfg();
    await applyConfig(c);
    expect(await getJob(weeklyScheduleJobId(c))).not.toBeNull();

    await saveConfig(toggle('off'), 'test'); // on → off ⇒ listener tears down
    expect(await getJob(weeklyScheduleJobId(c))).toBeNull();
    expect((await getSubscription(anniversaryTriggerSubscriptionId(c)))?.state).toBe('paused');
  });

  it('a no-op status save (no change) does NOT tear down', async () => {
    await saveConfig(toggle('on'), 'test');
    const c = cfg();
    await applyConfig(c);
    await saveConfig(toggle('on'), 'test'); // on → on: no status change, no teardown
    expect(await getJob(weeklyScheduleJobId(c))).not.toBeNull();
  });
});

describe('INS-4 — anniversary workflow parameterizes the Workday resource', () => {
  it('declares a workdayResource variable (default serviceDates) wired to the node resource input', () => {
    const v = anniversaryDraftDefinition.variables?.find((x) => x.name === 'workdayResource');
    expect(v).toBeDefined();
    expect(v?.defaultValue).toBe('serviceDates');

    const node = anniversaryDraftDefinition.nodes.find((n) => n.nodeId === 'milestones');
    // The node still carries the serviceDates config default (no-regression fallback)...
    expect((node?.config as { resource?: string } | undefined)?.resource).toBe('serviceDates');
    // ...and wires the variable to its `resource` input so a run can override it.
    expect((node?.inputs as Record<string, unknown> | undefined)?.resource)
      .toEqual({ type: 'variable', variableName: 'workdayResource' });
  });
});
