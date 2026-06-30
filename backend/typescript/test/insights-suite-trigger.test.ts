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
import { registerBuiltinWorkflow } from '../src/host/builtinWorkflows.js';
import { anniversaryDraftDefinition, ANNIVERSARY_DRAFT_ID } from '../src/features/insights-suite/metaWorkflows.js';
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
  updatedAt: new Date().toISOString(),
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
    registerBuiltinWorkflow(anniversaryDraftDefinition);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetTriggerBridgeStore();
    await __resetInsightsSuiteStore();
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
    await applyConfig(cfg({ updatedAt: new Date().toISOString() }));
    expect((await listSubscriptions('t1')).filter((s) => s.workflowId === ANNIVERSARY_DRAFT_ID)).toHaveLength(1);
  });

  it('disabling pauses the subscription; re-enabling revives it (registerSubscription alone would not)', async () => {
    const config = cfg();
    const subId = anniversaryTriggerSubscriptionId(config);
    await applyConfig(config);
    expect((await getSubscription(subId))?.state).toBe('active');
    await applyConfig(cfg({ anniversaryTriggerEnabled: false, updatedAt: new Date().toISOString() }));
    expect((await getSubscription(subId))?.state).toBe('paused');
    await applyConfig(cfg({ anniversaryTriggerEnabled: true, updatedAt: new Date().toISOString() }));
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

  it('a re-delivered anniversary event (same externalDeliveryId) dedups to the prior run — effectively-once', async () => {
    const config = cfg();
    await applyConfig(config);
    const subId = anniversaryTriggerSubscriptionId(config);
    const ev = {
      source: 'webhook' as const,
      rawBody: JSON.stringify({ subjectId: 'subj-7', milestone: '7 years' }),
      externalDeliveryId: 'wd-anniv-dup',
    };
    const r1 = await ingestExternalEvent(deps, subId, ev);
    expect(r1.outcome).toBe('delivered');
    const r2 = await ingestExternalEvent(deps, subId, ev);
    expect(r2.outcome).toBe('deduped');
    expect(r2.runId).toBe(r1.runId);
  });

  it('a disabled (paused) subscription skips ingestion — no run starts', async () => {
    const config = cfg({ anniversaryTriggerEnabled: false });
    await applyConfig(config);
    const subId = anniversaryTriggerSubscriptionId(config);
    const result = await ingestExternalEvent(deps, subId, {
      source: 'webhook',
      rawBody: JSON.stringify({ subjectId: 'subj-9', milestone: '5 years' }),
      externalDeliveryId: 'wd-anniv-paused',
    });
    expect(result.outcome).toBe('skipped');
    expect(result.runId).toBeUndefined();
  });
});
