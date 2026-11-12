/**
 * ADR 0081 Phase 4 → ADR 1102 D6 — the work-anniversary trigger, which this host
 * does NOT arm.
 *
 * ADR 0081 P4 armed a webhook subscription that started `anniversary-draft` on an
 * ingested anniversary event, and this file witnessed that it registered, paused,
 * revived and delivered. It never witnessed the run getting anywhere: the chain
 * requires `subjectId`, `workdayBaseUrl` and `recipient`, the trigger lane seeds
 * declared defaults only (ADR 0677 `ISWF-6a`), and mapping the event into the bag is
 * `ISWF-6b`, still deferred. So every fire died at its first node (`INS91-6`), and the
 * config door logged `anniversaryArmed:true` about it. ADR 1102 D6 refuses to arm it
 * in `applyConfig`, the one choke point, and pauses any row a pre-1102 save left.
 *
 * Red when: `applyConfig` arms a subscription again; the refusal writes the config
 * row first; a save stops pausing the caller's legacy row or stops DELETING another
 * principal's (`INS91-5`); a paused row starts runs on ingest.
 *
 * When `ISWF-6b` lands, the refusal case below is the one that must flip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetTriggerBridgeStore,
  getSubscription,
  listSubscriptions,
  registerSubscription,
} from '../src/host/triggerBridgeService.js';
import { ingestExternalEvent } from '../src/host/triggerIngestionService.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { insightsSuiteFeature } from '../src/features/insights-suite/feature.js';
import { registerInsightsMetaWorkflows, ANNIVERSARY_DRAFT_ID } from '../src/features/insights-suite/metaWorkflows.js';
import {
  loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import {
  applyConfig,
  anniversaryTriggerSubscriptionId,
  getConfig,
  __resetInsightsSuiteStore,
  type InsightsSuiteConfig,
} from '../src/features/insights-suite/insightsSuiteService.js';
import { OpenwopError } from '../src/types.js';

const cfg = (over: Partial<InsightsSuiteConfig> = {}): InsightsSuiteConfig => ({
  tenantId: 't1',
  principalUserId: 'u-ceo',
  businessUnit: 'TX',
  anniversaryTriggerEnabled: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('ADR 1102 D6 — the work-anniversary trigger is refused, and legacy rows are disarmed (sqlite memory)', () => {
  const storage = openSqliteStorage(':memory:');
  const hostSuite = createHostAdapterSuite({ storage });
  const deps = { storage, hostSuite };

  beforeAll(() => {
    initHostExtPersistence(storage);
    setEventLogBackend(storage);
    // The catalog resolves feature built-ins from a module-global map populated at boot;
    // register it directly so ingestion resolves the anniversary-draft workflow.
    // ADR 0472 P2 — the anniversary workflow is chain-backed now (resolve-by-id under
    // the same id via getChainBackedWorkflow); load the pack + register it.
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    registerInsightsMetaWorkflows();
    // ADR 0599 §6 — ingest now resolves the subscription's owning feature for the
    // subscription's tenant and FAILS CLOSED when it cannot. This suite previously
    // registered no toggle default at all, so `resolveOne` answered null and every
    // ingest would skip `feature-disabled`. Registering the real default + turning
    // it on is what keeps these deliveries measuring delivery.
    registerToggleDefault(insightsSuiteFeature.toggleDefault!);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetTriggerBridgeStore();
    await __resetInsightsSuiteStore();
    await __clearToggleStore();
    await saveConfig({ ...insightsSuiteFeature.toggleDefault!, status: 'on' }, 'trigger-test');
  });

  /** A subscription as a pre-ADR-1102 save left it (the arming path is gone). */
  const legacyArmed = (principal: string) => registerSubscription({
    subscriptionId: `insights-anniversary:t1:${principal}`,
    tenantId: 't1',
    source: 'webhook',
    workflowId: ANNIVERSARY_DRAFT_ID,
    featureId: 'insights-suite',
    verificationMode: 'none',
    label: 'Work-anniversary recognition draft',
  });

  it('arming is refused with a typed 400, BEFORE anything is written', async () => {
    let err: unknown;
    try { await applyConfig(cfg({ anniversaryTriggerEnabled: true })); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).httpStatus).toBe(400);
    expect((err as OpenwopError).details).toMatchObject({ field: 'anniversaryTriggerEnabled', reason: 'trigger_lane_unrunnable' });
    expect(await getConfig('t1'), 'a refusal that persists is worse than the bug').toBeNull();
    expect(await listSubscriptions('t1')).toEqual([]);
  });

  it('a save PAUSES the caller\'s own legacy subscription (its delivery history is kept)', async () => {
    await legacyArmed('u-ceo');
    expect((await getSubscription('insights-anniversary:t1:u-ceo'))?.state).toBe('active');
    await applyConfig(cfg());
    expect((await getSubscription(anniversaryTriggerSubscriptionId(cfg())))?.state).toBe('paused');
  });

  it('a save DELETES another principal\'s legacy subscription (INS91-5)', async () => {
    await legacyArmed('u-previous');
    await applyConfig(cfg());
    expect(await getSubscription('insights-anniversary:t1:u-previous'), 'a previous principal\'s trigger kept accepting events').toBeNull();
  });

  it('a paused legacy subscription skips ingestion — no run starts', async () => {
    await legacyArmed('u-ceo');
    await applyConfig(cfg());
    const subId = anniversaryTriggerSubscriptionId(cfg());
    expect((await getSubscription(subId))?.state).toBe('paused');
    const result = await ingestExternalEvent(deps, subId, {
      source: 'webhook',
      rawBody: JSON.stringify({ subjectId: 'subj-9', milestone: '5 years' }),
      externalDeliveryId: 'wd-anniv-paused',
    });
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('paused');
    expect(result.runId).toBeUndefined();
  });
});
