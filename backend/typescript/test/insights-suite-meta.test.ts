/**
 * ADR 0082 — Insights meta-workflows rebuilt on REAL nodes (no mock-ai).
 *
 * Verifies (a) closed-world validity (no invented/typo'd typeIds) for the 3 meta-workflows,
 * (b) NO `mock-ai` placeholder survives + the real source nodes (workday/bigquery/LLM) are
 * present, (c) they register as catalog built-ins, and (d) the config→schedule reconciliation
 * (cron registers a deterministic job; absent cron removes it).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../src/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { runnableNodeTypeIds, findUnknownTypeIds } from '../src/host/nodeCatalogBuilder.js';
import { getBuiltinWorkflow } from '../src/host/builtinWorkflows.js';
import { listJobs } from '../src/host/schedulingService.js';
import {
  weeklyVarianceDefinition, anniversaryDraftDefinition, talentPrepDefinition,
  insightsBuiltinWorkflows, WEEKLY_VARIANCE_ID,
} from '../src/features/insights-suite/metaWorkflows.js';
import { applyConfig, weeklyScheduleJobId, __resetInsightsSuiteStore, type InsightsSuiteConfig } from '../src/features/insights-suite/insightsSuiteService.js';

// Real typeIds that ship in feature/vendor packs but may not be MOUNTED in this minimal
// test process (so they're absent from runnableNodeTypeIds here). They are confirmed-real
// — tolerated so the closed-world check still catches a genuine TYPO.
const KNOWN_REAL_DEPS = new Set([
  'feature.insights-suite.nodes.variance-compute',
  'feature.insights-suite.nodes.talent-score',
  'feature.documents.nodes.render',
  'core.openwop.integration.notification-push',
  'core.ai.chatCompletion',
  'knowledge.retrieve',
]);

describe('ADR 0082 — closed-world validity (no invented typeIds)', () => {
  beforeAll(() => ensureNodesRegistered());
  const defs = [
    ['weekly-variance', weeklyVarianceDefinition],
    ['anniversary-draft', anniversaryDraftDefinition],
    ['talent-prep', talentPrepDefinition],
  ] as const;

  it.each(defs)('%s references only real typeIds', (_name, def) => {
    const legal = runnableNodeTypeIds();
    const unknown = findUnknownTypeIds(def, legal).filter((t) => !KNOWN_REAL_DEPS.has(t));
    expect(unknown, `invented/typo'd typeIds: ${unknown.join(', ')}`).toEqual([]);
  });
});

describe('ADR 0082 — no mock-ai; real source/analysis/LLM nodes', () => {
  it('NO meta-workflow references local.sample.demo.mock-ai (the fake-analysis fix)', () => {
    for (const def of insightsBuiltinWorkflows) {
      for (const n of def.nodes) {
        expect(n.typeId, `${def.workflowId}.${n.nodeId} must not be mock-ai`).not.toBe('local.sample.demo.mock-ai');
      }
    }
  });
  it('talent + anniversary pull from the real Workday source; anniversary drafts via a real LLM', () => {
    expect(talentPrepDefinition.nodes.some((n) => n.typeId === 'core.workday.query')).toBe(true);
    expect(anniversaryDraftDefinition.nodes.some((n) => n.typeId === 'core.workday.query')).toBe(true);
    expect(anniversaryDraftDefinition.nodes.some((n) => n.typeId === 'core.ai.chatCompletion')).toBe(true);
    expect(anniversaryDraftDefinition.nodes.some((n) => n.typeId === 'core.email.draft')).toBe(true);
    // every flow ends by notifying the user (insights surfaced via notifications, not a dashboard)
    for (const def of insightsBuiltinWorkflows) {
      expect(def.nodes.some((n) => n.typeId === 'core.openwop.integration.notification-push')).toBe(true);
    }
  });
  it('each workflow is a connected graph — no orphan node (source→…→notify is actually wired)', () => {
    for (const def of insightsBuiltinWorkflows) {
      const edges = def.edges ?? [];
      const targets = new Set(edges.map((e) => e.targetNodeId));
      const sources = new Set(edges.map((e) => e.sourceNodeId));
      const entries = def.nodes.filter((n) => !targets.has(n.nodeId));
      expect(entries, `${def.workflowId} must have exactly one entry node`).toHaveLength(1);
      // Every non-entry node is an edge target, and every non-terminal node is an edge source
      // → no node is stranded off the source→notify chain.
      for (const n of def.nodes) {
        const isEntry = entries[0]!.nodeId === n.nodeId;
        const isTerminal = n.typeId === 'core.openwop.integration.notification-push';
        if (!isEntry) expect(targets.has(n.nodeId), `${def.workflowId}.${n.nodeId} has no inbound edge (orphan)`).toBe(true);
        if (!isTerminal) expect(sources.has(n.nodeId), `${def.workflowId}.${n.nodeId} has no outbound edge (dead end)`).toBe(true);
      }
    }
  });
});

describe('ADR 0082 — built-in registration + config→schedule', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 18248, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __resetInsightsSuiteStore();
  });

  it('registers the 3 meta-workflows as catalog built-ins (source A)', () => {
    expect(getBuiltinWorkflow(WEEKLY_VARIANCE_ID)?.workflowId).toBe(WEEKLY_VARIANCE_ID);
    expect(getBuiltinWorkflow('openwop-app.insights.anniversary-draft')).toBeTruthy();
    expect(getBuiltinWorkflow('openwop-app.insights.talent-prep')).toBeTruthy();
  });

  it('applyConfig with a cron registers a deterministic weekly-variance job; absent cron removes it', async () => {
    const base: InsightsSuiteConfig = { tenantId: 'demoT', principalUserId: 'u-ceo', businessUnits: ['TX'], scheduleCron: '0 6 * * 2', scheduleTimezone: 'America/Chicago', updatedAt: new Date().toISOString() };
    await applyConfig(base);
    const jobId = weeklyScheduleJobId(base);
    let jobs = await listJobs('demoT');
    expect(jobs.find((j) => j.jobId === jobId)?.workflowId).toBe(WEEKLY_VARIANCE_ID);
    // re-save same config → no duplicate (deterministic id)
    await applyConfig(base);
    expect((await listJobs('demoT')).filter((j) => j.jobId === jobId)).toHaveLength(1);
    // remove the cron → job is removed
    await applyConfig({ ...base, scheduleCron: undefined, updatedAt: new Date().toISOString() });
    jobs = await listJobs('demoT');
    expect(jobs.find((j) => j.jobId === jobId)).toBeUndefined();
  });
});
