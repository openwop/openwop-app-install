/**
 * ADR 0081 Phase 4 — Workday work-anniversary trigger source.
 *
 * `applyConfig` reconciles a deterministic webhook trigger subscription that starts the
 * `anniversary-draft` meta-workflow: enabling registers it active, disabling pauses it
 * (there is no deleteSubscription — pause makes ingest a no-op, architect C1), re-enable
 * revives it, and re-save is idempotent. An ingested anniversary-shaped event resolves
 * the workflow and starts a run carrying subjectId/milestone as ctx.triggerData.
 *
 * The Workday→event emission (Workday POSTing the anniversary webhook to the ingest
 * endpoint) is the integration boundary, NOT host code — the ingest seam is exercised
 * here directly with an anniversary-shaped payload (no live Workday needed).
 *
 * Sabotage-witnessed (/grade-tests w20): binding the subscription to the wrong workflow,
 * an id that varies per save, dropping the revive or the pause write, or not registering
 * the chain-backed anniversary workflow each red the case named for it. Every config
 * carries a FIXED, distinct `updatedAt`: two `new Date()` saves can share a millisecond,
 * which made a re-save byte-identical and the idempotency case unable to fail. The generic
 * §C-1 dedup case was cut — `trigger-ingestion.test.ts` › "dedup: a re-delivery of the same
 * external delivery id returns the prior runId (effectively-once)" goes red under the same
 * sabotage, and `applyConfig` passes no dedup option of its own.
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
} from '../src/host/triggerBridgeService.js';
import { ingestExternalEvent, type TriggerEvent } from '../src/host/triggerIngestionService.js';
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
  __resetInsightsSuiteStore,
  type InsightsSuiteConfig,
} from '../src/features/insights-suite/insightsSuiteService.js';

const cfg = (over: Partial<InsightsSuiteConfig> = {}): InsightsSuiteConfig => ({
  tenantId: 't1',
  principalUserId: 'u-ceo',
  businessUnits: ['TX'],
  anniversaryTriggerEnabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('ADR 0081 §4 — work-anniversary trigger subscription (sqlite memory)', () => {
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

  it('enabled config registers a deterministic, active subscription bound to anniversary-draft', async () => {
    const config = cfg();
    await applyConfig(config);
    const subId = anniversaryTriggerSubscriptionId(config);
    expect(subId).toBe('insights-anniversary:t1:u-ceo');
    const sub = await getSubscription(subId);
    expect(sub?.workflowId).toBe(ANNIVERSARY_DRAFT_ID);
    expect(sub?.source).toBe('webhook');
    expect(sub?.state).toBe('active');
  });

  it('re-save is idempotent (one subscription, deterministic id)', async () => {
    await applyConfig(cfg());
    await applyConfig(cfg({ updatedAt: '2026-01-02T00:00:00.000Z' }));
    expect((await listSubscriptions('t1')).filter((s) => s.workflowId === ANNIVERSARY_DRAFT_ID)).toHaveLength(1);
  });

  it('disabling pauses the subscription; re-enabling revives it (registerSubscription alone would not)', async () => {
    const config = cfg();
    const subId = anniversaryTriggerSubscriptionId(config);
    await applyConfig(config);
    expect((await getSubscription(subId))?.state).toBe('active');
    await applyConfig(cfg({ anniversaryTriggerEnabled: false, updatedAt: '2026-01-02T00:00:00.000Z' }));
    expect((await getSubscription(subId))?.state).toBe('paused');
    await applyConfig(cfg({ anniversaryTriggerEnabled: true, updatedAt: '2026-01-03T00:00:00.000Z' }));
    expect((await getSubscription(subId))?.state).toBe('active');
  });

  it('an ingested anniversary event resolves anniversary-draft and starts a run carrying subjectId/milestone in ctx.triggerData', async () => {
    const config = cfg();
    await applyConfig(config);
    const subId = anniversaryTriggerSubscriptionId(config);
    const result = await ingestExternalEvent(deps, subId, {
      source: 'webhook',
      method: 'POST',
      headers: { 'x-event': 'worker.anniversary' },
      rawBody: JSON.stringify({ subjectId: 'subj-42', milestone: '10 years' }),
      externalDeliveryId: 'wd-anniv-1',
    });
    expect(result.outcome).toBe('delivered');
    expect(result.runId).toBeTruthy();
    const run = await storage.getRun(result.runId!);
    expect(run?.workflowId).toBe(ANNIVERSARY_DRAFT_ID);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.source).toBe('webhook');
    expect(te.contentTrust).toBe('untrusted'); // external input is untrusted (LLM nodes wrap it)
    expect(te.webhook?.body).toEqual({ subjectId: 'subj-42', milestone: '10 years' });
  });

  it('a disabled (paused) subscription skips ingestion — no run starts', async () => {
    // Arm it FIRST: disabling a never-armed trigger pauses nothing (no row exists), and
    // ingest then skips for "no subscription", not "paused" — the state this case
    // used to pass in (/grade-tests w20).
    const subId = anniversaryTriggerSubscriptionId(cfg());
    await applyConfig(cfg());
    await applyConfig(cfg({ anniversaryTriggerEnabled: false, updatedAt: '2026-01-02T00:00:00.000Z' }));
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
