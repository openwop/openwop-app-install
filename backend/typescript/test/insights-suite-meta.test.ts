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
import { getChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerInsightsMetaWorkflows } from '../src/features/insights-suite/metaWorkflows.js';
import { listJobs } from '../src/host/schedulingService.js';
import {
  buildInsightsMetaWorkflow, insightsPostProcess, WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID, TALENT_PREP_ID,
} from '../src/features/insights-suite/metaWorkflows.js';
import {
  loadWorkflowChainPacks, defaultWorkflowChainPackRoots, getChain, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

// ADR 0472 P2 — the meta-workflows migrated to chain packs; build the MIGRATED defs.
_resetChainRegistryForTest();
loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
const weeklyVarianceDefinition = buildInsightsMetaWorkflow(WEEKLY_VARIANCE_ID);
const anniversaryDraftDefinition = buildInsightsMetaWorkflow(ANNIVERSARY_DRAFT_ID);
const talentPrepDefinition = buildInsightsMetaWorkflow(TALENT_PREP_ID);
const insightsBuiltinWorkflows = [weeklyVarianceDefinition, anniversaryDraftDefinition, talentPrepDefinition];
import { applyConfig, weeklyScheduleJobId, __resetInsightsSuiteStore, type InsightsSuiteConfig } from '../src/features/insights-suite/insightsSuiteService.js';

// Real typeIds that ship in feature/vendor packs but may not be MOUNTED in this minimal
// test process (so they're absent from runnableNodeTypeIds here). They are confirmed-real
// — tolerated so the closed-world check still catches a genuine TYPO.
const KNOWN_REAL_DEPS = new Set([
  'feature.insights-suite.nodes.variance-compute',
  'feature.insights-suite.nodes.talent-score',
  'feature.notifications.nodes.notify',
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
      expect(def.nodes.some((n) => n.typeId === 'feature.notifications.nodes.notify')).toBe(true);
    }
  });
  it('PROBE-DOC-4 (WF-DOC-3 / GEN-DOC-3, UN-NARROWED by ADR 0599 §4): every node in the EXPANDED defs binds the config its implementation hard-requires — connectedness is not runnability', () => {
    // The witness the old suite lacked: `weekly-variance.render` shipped with
    // NO inputs block, so it called the surface with empty orgId/documentId
    // and died `not_found` — after a cron fire had already consumed a BigQuery
    // query and a human approval. The connectedness test below stayed green
    // throughout.
    //
    // ── Why this was rewritten (ADR 0599 §4) ────────────────────────────────
    // The original cure filtered `if (!n.typeId.startsWith('feature.documents.
    // nodes.')) continue;` — the instance, not the class. The 1.1.0 chain then
    // dropped the only documents node, and the comment here recorded the result
    // honestly: "the loop is currently vacuously green for this pack." It stayed
    // vacuous while FIVE live instances of the identical defect sat in the same
    // three chains — BigQuery, Workday ×2, knowledge and email nodes, every one
    // of them outside the filter. Enumerate the CLASS, not the instance.
    //
    // The table below is a FLOOR, derived by reading each implementation's own
    // early `invalid_config` / `INVALID_INPUTS` return. It is not schema-driven
    // because `core.email.draft` is code-registered in `bootstrap/nodes.ts` with
    // NO pack manifest and therefore no `configSchemaRef` for the chain loader's
    // required-config gate to read — the structural root cause (ISU-4), tracked
    // as a residual in ADR 0599 §9 rather than fixed here.
    const REQUIRED_BINDINGS: Record<string, string[]> = {
      'core.bigquery.query': ['projectId', 'sql'],
      'core.workday.query': ['baseUrl', 'resource'],
      'core.email.draft': ['to', 'subject'],
      'core.email.send': ['to', 'subject'],
      'knowledge.retrieve': ['query'],
      'feature.documents.nodes.render': ['orgId', 'documentId'],
      'feature.documents.nodes.get-document': ['orgId', 'documentId'],
      'feature.documents.nodes.create-document': ['orgId'],
    };
    // Anti-vacuity anchor #1: the table must actually MATCH something in these
    // chains. A future edit that renames a typeId would otherwise silently
    // re-vacuum the loop, which is precisely how this probe died the first time.
    let checked = 0;
    for (const def of insightsBuiltinWorkflows) {
      for (const n of def.nodes) {
        const required = REQUIRED_BINDINGS[n.typeId];
        if (!required) continue;
        checked++;
        const bound = new Set([
          ...Object.keys((n.config ?? {}) as Record<string, unknown>),
          ...Object.keys((n.inputs ?? {}) as Record<string, unknown>),
        ]);
        for (const key of required) {
          expect(
            bound.has(key),
            `${def.workflowId}.${n.nodeId} (${n.typeId}) binds no ${key} — it cannot succeed as authored`,
          ).toBe(true);
        }
      }
    }
    expect(checked, 'PROBE-DOC-4 matched ZERO nodes — the loop has gone vacuous again').toBeGreaterThanOrEqual(5);
    // Anti-vacuity anchor #2 (kept from the original): the 1.1.0 weekly-variance
    // must actually have DROPPED the input-less render node, not kept it.
    expect(
      weeklyVarianceDefinition.nodes.some((n) => n.typeId === 'feature.documents.nodes.render'),
      'weekly-variance still carries the input-less render node',
    ).toBe(false);
  });

  it('ADR 0599 §5 — no insights chain is ZERO-CONFIG, so the demo seeder cannot mint copies into OFF tenants', () => {
    // `seedZeroConfigWorkflows` seeds any chain with no non-empty `required`
    // array into the tenant ownership index as `wf.seed.<chainId>` — visible and
    // runnable in `/builder` and the `/` picker for a seeded tenant whose
    // `insights-suite` toggle is OFF. All three chains qualified, so the demo
    // seed handed every seeded tenant three workflows that died at node 1.
    // Declaring the tenant-specific values `required` is what takes them out of
    // the seeder. Assert the property, not the spelling.
    //
    // ADR 0599 §Correction 3 — this comment used to add "(a launch refuses
    // instead of starving)". It does NOT. No required-variable refusal exists:
    // `variablesRuntime.ts` says outright "The runtime doesn't gate on
    // `required`"; ADR 0504 (`routes/runs.ts`) built a run-start refusal, measured
    // that it would break 114 of 169 seeded chains, and did not ship it; and
    // `routes/workflows.ts` carries its own correction saying that enforcement was
    // reverted and its error code exists nowhere. Measured here too: all three
    // chains still die `invalid_config` at node 1 when launched with no inputs.
    // The seeder exclusion below is the ONLY thing `required` buys, and it is real.
    const isZeroConfig = (params: Record<string, unknown>): boolean => {
      const required = (params as { required?: unknown }).required;
      return !Array.isArray(required) || required.length === 0;
    };
    for (const chainId of [WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID, TALENT_PREP_ID]) {
      const chain = getChain(chainId)?.chain;
      expect(chain, `${chainId} is not loaded`).toBeTruthy();
      expect(
        isZeroConfig(chain!.parameters as Record<string, unknown>),
        `${chainId} is zero-config — the demo seeder will mint an owned copy for every seeded tenant, toggle OFF or not`,
      ).toBe(false);
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
        const isTerminal = n.typeId === 'feature.notifications.nodes.notify';
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

  it('registers the 3 meta-workflows CHAIN-BACKED under the stable ids (source A) — ADR 0472 P2', () => {
    _resetChainBackedWorkflowsForTest();
    registerInsightsMetaWorkflows(); // the real feature registration (packs loaded at module top)
    // Same stable ids (chainId === the original) resolve in catalog source A via the
    // chain-backed registry now, so scheduler/trigger ignition + replay are unchanged.
    expect(getChainBackedWorkflow(WEEKLY_VARIANCE_ID)?.workflowId).toBe(WEEKLY_VARIANCE_ID);
    expect(getChainBackedWorkflow('openwop-app.insights.anniversary-draft')).toBeTruthy();
    expect(getChainBackedWorkflow('openwop-app.insights.talent-prep')).toBeTruthy();
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

/**
 * `PROBE-IS-8` (closes `ISWF-12` + `ISWF-18`) — ADR 0600 §4.
 *
 * `withOutputRoles` is the ONLY reason the `postProcess` hook is used by this
 * feature, and `grep -rn "outputRole" backend/typescript/test/*.ts | grep -i
 * insight` returned nothing: no test asserted which node ends up primary, that
 * `expandChain`'s auto-terminal-primary was cleared, or that the suffix matcher
 * picks the node it means to.
 *
 * These pin the MEASURED behaviour, not the docblock's. Measuring first is what
 * turned `ISU-23` from "curation with no consumer" into the sharper fact: on two
 * of three chains the map STRIPS `primary` off the graph terminal and puts it on
 * a node with outgoing edges, which the SPA's completion card filtered out by
 * construction. The host is right (a deliverable is not a graph position) and
 * the consumer was fixed; these tests hold the host side still.
 */
describe('PROBE-IS-8 — outputRole curation (ADR 0600 §4)', () => {
  const roleOf = (def: typeof weeklyVarianceDefinition, origId: string): string | undefined =>
    def.nodes.find((n) => n.nodeId === origId || n.nodeId.endsWith(`_${origId}`))?.outputRole;

  it('each chain has EXACTLY ONE primary, and it is the declared deliverable', () => {
    const expected: Array<[typeof weeklyVarianceDefinition, string]> = [
      [weeklyVarianceDefinition, 'notify'],
      [anniversaryDraftDefinition, 'emailDraft'],
      [talentPrepDefinition, 'score'],
    ];
    for (const [def, origId] of expected) {
      const primaries = def.nodes.filter((n) => n.outputRole === 'primary');
      expect(primaries, `${def.workflowId} must declare exactly one primary`).toHaveLength(1);
      expect(roleOf(def, origId), `${def.workflowId}: ${origId} must be the primary`).toBe('primary');
    }
  });

  it("expandChain's auto-terminal-primary on `notify` IS CLEARED where a deliverable is declared", () => {
    // This is the post-processor's whole stated purpose, and nothing asserted it.
    // Without the clear, `notify` (a bell ring) would sit beside `emailDraft` /
    // `score` as a second primary and the completion card would offer both.
    expect(roleOf(anniversaryDraftDefinition, 'notify')).toBeUndefined();
    expect(roleOf(talentPrepDefinition, 'notify')).toBeUndefined();
    // …and NOT cleared on the chain that genuinely declares `notify` — the
    // polarity that keeps the assertion above from passing over a blanket wipe.
    expect(roleOf(weeklyVarianceDefinition, 'notify')).toBe('primary');
  });

  it('NO node carries `secondary` — it is retired, not merely unused', () => {
    // `secondary` has no consumer anywhere in the SPA: the only reader tests
    // `=== 'primary'`, and when any primary exists the surfaced list narrows to
    // it alone, so a `secondary` tag renders identically whether present or
    // absent. Shipping it taught an authoring signal that does nothing.
    for (const def of insightsBuiltinWorkflows) {
      expect(
        def.nodes.filter((n) => n.outputRole === 'secondary').map((n) => n.nodeId),
        `${def.workflowId} still ships a decorative secondary`,
      ).toEqual([]);
    }
  });

  it('ISWF-18: a node id that is a `_`-suffix of another cannot steal its role', () => {
    // The old matcher took the FIRST `Object.entries(roles).find(...)` hit by
    // `endsWith('_' + origId)`, so a chain adding `re_score` beside `score` would
    // assign by insertion order. Vacuously safe on today's corpus and unsafe by
    // construction — the parameter un-prefixing path hit this exact bug and was
    // fixed with longest-first + consume-once; this one never was.
    const def = buildInsightsMetaWorkflow(TALENT_PREP_ID);
    const scoreNode = def.nodes.find((n) => n.nodeId.endsWith('_score'))!;
    const decoyId = `${scoreNode.nodeId.replace(/_score$/, '')}_re_score`;
    // Insert the decoy FIRST, so an order-dependent matcher picks it, and strip
    // every pre-existing role so only the post-processor's own writes are read.
    const withDecoy = {
      ...def,
      nodes: [
        { ...scoreNode, nodeId: decoyId, outputRole: undefined },
        ...def.nodes.map((n) => ({ ...n, outputRole: undefined })),
      ],
    };
    // The REAL production post-processor, not an extracted copy.
    insightsPostProcess(TALENT_PREP_ID)(withDecoy);
    expect(withDecoy.nodes.find((n) => n.nodeId === decoyId)?.outputRole).toBeUndefined();
    expect(withDecoy.nodes.find((n) => n.nodeId === scoreNode.nodeId)?.outputRole).toBe('primary');
  });
});
