/**
 * ADR 0078 Phase 4 — governance binding (verification).
 *
 * Pins the invariants the prior phases produce: (a) talent data is confidential-pii
 * and subjectId is in the masking union; (b) a talent subjectId is masked in logs;
 * (c) STRUCTURAL no-auto-side-effect — every meta-workflow with a surfacing/egress node
 * has a core.approvalGate upstream, email.draft is draft-only, and no node can send.
 *
 * Approval-required for the suite is enforced by the in-workflow core.approvalGate +
 * the structural never-send of core.email.draft — NOT governanceService.actionPolicyOf
 * (the assistant action loop, a surface this suite does not use). The suite registers
 * nothing with governanceService.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { classificationOf, isKnownPiiFieldName, isPiiField, maskPiiDeep } from '../src/host/dataClassification.js';
import '../src/features/insights-suite/insightsSuiteService.js'; // declarePiiFields side-effect
import { createLogger } from '../src/observability/logger.js';
import {
  buildInsightsMetaWorkflow, WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID,
} from '../src/features/insights-suite/metaWorkflows.js';
import {
  loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest, listChains,
} from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

// ADR 0472 P2 — the meta-workflows migrated to chain packs; build the MIGRATED defs.
_resetChainRegistryForTest();
loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
const weeklyVarianceDefinition = buildInsightsMetaWorkflow(WEEKLY_VARIANCE_ID);
const anniversaryDraftDefinition = buildInsightsMetaWorkflow(ANNIVERSARY_DRAFT_ID);
/**
 * ADR 0600 §Correction 10 (`LOW-2`) — DERIVED FROM THE PACK, not hand-listed.
 *
 * This was a hardcoded three-element array. §7's `ISC-15` closed world is
 * closed over NODES and was open over CHAINS: a fourth chain added to
 * `examples/workflow-chain-packs/insights-suite/pack.json` would never be
 * walked, so a send-capable node inside it would pass the never-send gate
 * unseen — and the anti-vacuity floor (`> 9` nodes) tolerated losing a whole
 * chain, because 3 chains carry 13 nodes and 2 still carry 10.
 *
 * "A new node, however spelled, fails until someone puts it on the list" was
 * only true for nodes in chains someone had already remembered to list. Now the
 * chain set comes from the registry the loader populated FROM the pack, so a new
 * chain is walked the moment it exists — and `EXPECTED_INSIGHTS_CHAINS` makes
 * losing one a red rather than a quieter pass.
 */
const INSIGHTS_CHAIN_IDS = listChains()
  .filter((c) => c.packName === 'core.openwop.workflows.insights-suite')
  .map((c) => c.chain.chainId)
  .sort();
const EXPECTED_INSIGHTS_CHAINS = 3;
const insightsBuiltinWorkflows = INSIGHTS_CHAIN_IDS.map((id) => buildInsightsMetaWorkflow(id));

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(typeof c === 'string' ? c : Buffer.from(c).toString()); return true; });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('');
}

describe('ADR 0078 §4 — (a) classification', () => {
  it('talent snapshot is confidential-pii; subjectId is in the masking union', () => {
    expect(classificationOf('insights.talentSnapshot')).toBe('confidential-pii');
    expect(isPiiField('insights.talentSnapshot', 'subjectId')).toBe(true);
    expect(isKnownPiiFieldName('subjectId')).toBe(true); // → masked everywhere in logs

    // ── ADR 0600 §7 (`ISC-14.3`) — the line below is a TAUTOLOGY, exhibited ──
    // It read "VarianceReport is internal (no person fields) — not
    // confidential-pii", which sounds like a classification guarantee and is
    // not one. `classificationOf` returns `'internal'` for ANY entity with no
    // declared PII fields (`host/dataClassification.ts`), and
    // `insights.varianceReport` is NEVER DECLARED — this feature declares only
    // `insights.talentSnapshot`. So the assertion passes for a reason that has
    // nothing to do with the entity, and it would stay green if the real
    // classification were wrong.
    //
    // PR-A (ADR 0599 §8 #8) left it rather than deleting it, because deleting it
    // would remove the only written trace that the entity was never declared.
    // The fix is neither: the tautology is DEMONSTRATED beside it with a name
    // that certainly does not exist, so the next reader cannot mistake either
    // line for coverage. Declaring the entity is a product decision (it has no
    // PII fields to declare, which is the whole reason it is absent).
    expect(classificationOf('insights.varianceReport')).toBe('internal');
    expect(
      classificationOf('definitely.not.a.registered.entity'),
      'if THIS is not internal, the line above has started meaning something and the note beside it is stale',
    ).toBe('internal');
  });
});

describe('ADR 0078 §4 — (b) PII masking', () => {
  afterEach(() => vi.restoreAllMocks());

  it('masks a talent subjectId but not the 9-box numbers (no over-masking)', () => {
    const masked = maskPiiDeep({ subjectId: 'u-123', box: 9, performance: 3, readiness: 'ready_now' }) as Record<string, unknown>;
    expect(masked.subjectId).toMatch(/^pii_/);
    expect(masked.box).toBe(9);
    expect(masked.performance).toBe(3);
    expect(masked.readiness).toBe('ready_now'); // generic word NOT in the union → untouched
  });

  it('a logged talent subjectId never reaches stdout verbatim', () => {
    const log = createLogger('test.insights');
    const out = capture(() => log.info('talent scored', { subjectId: 'u-secret-123' }));
    expect(out).not.toContain('u-secret-123');
    expect(out).toMatch(/pii_/);
  });
});

describe('ADR 0078 §4 — (c) structural no-auto-side-effect', () => {
  const hasNode = (def: WorkflowDefinition, typeId: string): boolean => def.nodes.some((n) => n.typeId === typeId);
  const nodeIdOf = (def: WorkflowDefinition, typeId: string): string | undefined => def.nodes.find((n) => n.typeId === typeId)?.nodeId;
  const edges = (def: WorkflowDefinition) => def.edges ?? [];

  it('weekly-variance: the approvalGate is upstream of notify (render dropped — WF-DOC-3)', () => {
    const gate = nodeIdOf(weeklyVarianceDefinition, 'core.approvalGate');
    const notify = nodeIdOf(weeklyVarianceDefinition, 'feature.notifications.nodes.notify');
    expect(gate && notify).toBeTruthy();
    // WF-DOC-3 (chain 1.1.0): the input-less render step was removed — it had
    // no orgId/documentId and could never succeed; a documents-owned chain is
    // the right home for a real render step.
    expect(nodeIdOf(weeklyVarianceDefinition, 'feature.documents.nodes.render')).toBeUndefined();
    // reachability: gate → notify (no surfacing before sign-off)
    const e = edges(weeklyVarianceDefinition);
    expect(e.some((x) => x.sourceNodeId === gate && x.targetNodeId === notify)).toBe(true);
  });

  it('anniversary-draft: an approvalGate exists and email is draft-only (never send)', () => {
    expect(hasNode(anniversaryDraftDefinition, 'core.approvalGate')).toBe(true);
    expect(hasNode(anniversaryDraftDefinition, 'core.email.draft')).toBe(true);
  });

  /**
   * ADR 0600 §7 (`ISC-15`) — the never-send guarantee, as a CLOSED WORLD.
   *
   * The old guard was `/send|sendmail/i.test(n.typeId)`: it polices a NAME, not
   * a capability. Any node reaching `ctx.email.send` (`host/emailAdapter.ts`,
   * wired into every run context by the executor) under a typeId lacking that
   * substring passed cleanly.
   *
   * THE PRESCRIBED CURE IS NOT IMPLEMENTABLE, and that is a measurement rather
   * than a preference. `ISC-15` asked for the guarantee to be re-expressed
   * against `executor/sideEffectFloor.generated.ts`, "which lists both insights
   * nodes". It does — and it does NOT list `core.email.draft` or
   * `core.email.send`, nor `core.bigquery.query`, `core.workday.query` or
   * `core.approvalGate`. That file is DERIVED FROM PACK MANIFESTS, and every one
   * of those nodes is code-registered in `bootstrap/nodes.ts` with no manifest
   * (`ISU-4`'s root cause). Grepped, not assumed: `core.email.draft` appears
   * ZERO times in the generated floor. So the instrument cannot see the node the
   * guarantee is about, and citing it would be coverage theatre.
   *
   * What IS available is a closed world. Every node typeId in the three chains
   * must be on a reviewed allowlist. That is strictly stronger than a substring
   * ban in the direction that matters: a NEW node — however it is spelled — fails
   * until someone puts it on the list and thereby looks at what it can do.
   */
  const REVIEWED_CHAIN_NODE_TYPES = new Set([
    'core.bigquery.query',
    'core.workday.query',
    'core.ai.chatCompletion',
    'knowledge.retrieve',
    'core.email.draft',
    'core.approvalGate',
    'feature.insights-suite.nodes.variance-compute',
    'feature.insights-suite.nodes.talent-score',
    'feature.notifications.nodes.notify',
  ]);

  it('every node in every meta-workflow is on the reviewed allowlist (closed world)', () => {
    let checked = 0;
    for (const def of insightsBuiltinWorkflows) {
      for (const n of def.nodes) {
        checked++;
        expect(
          REVIEWED_CHAIN_NODE_TYPES.has(n.typeId),
          `${def.workflowId}.${n.nodeId} (${n.typeId}) is not on the reviewed node allowlist. `
          + 'Adding it means confirming it cannot reach ctx.email.send — that confirmation is the point of this gate.',
        ).toBe(true);
      }
    }
    // Anti-vacuity, in TWO dimensions — §Correction 10 (`LOW-2`).
    //
    // The node floor alone was not enough: 3 chains carry 13 nodes and 2 still
    // carry 10, so `> 9` passed over a corpus that had silently LOST a chain.
    // The chain count is asserted exactly, and it is derived from the pack, so
    // adding a fourth chain reds here and the author must confirm the walk
    // covers it rather than discovering later that it never did.
    expect(INSIGHTS_CHAIN_IDS.length,
      `the pack now declares ${INSIGHTS_CHAIN_IDS.length} insights chains, not ${EXPECTED_INSIGHTS_CHAINS} `
      + `(${INSIGHTS_CHAIN_IDS.join(', ')}). Confirm the new chain's nodes are on the reviewed allowlist, then bump this.`,
    ).toBe(EXPECTED_INSIGHTS_CHAINS);
    expect(checked, 'the walk found no nodes — this gate would pass over an empty corpus').toBeGreaterThan(9);
  });

  it('the allowlist itself contains no send-capable node typeId (the cheap tripwire, kept)', () => {
    // Orthographic and known to be so. Retained BESIDE the closed world rather
    // than in place of it: it costs one line and it is the check that fires
    // fastest when someone reaches for the obvious wrong node.
    for (const typeId of REVIEWED_CHAIN_NODE_TYPES) {
      expect(/send|sendmail/i.test(typeId), `${typeId} must not be send-capable`).toBe(false);
    }
  });
});

/**
 * ADR 0599 §7 (ISC-8) — the fail-open shape, made local and checkable.
 *
 * `resolveEffectiveAccess` returns the tenant-OWNER principal with the full owner
 * scope set when neither `subject` nor `memberId` is supplied (its own header calls
 * this out: "the fail direction is open"). Both of this feature's gates passed
 * `subject: actingUserOf(req)` straight through, so a request with no `req.userId`
 * and no `req.principal` would have cleared BOTH read and write.
 *
 * That was latent, not live — `authMiddleware` always populates `req.principal`. The
 * point of this test is that the safety no longer depends on a promise kept in a
 * different file with nothing asserting it here.
 */
describe('ADR 0599 §7 — the config gates refuse a request with no acting subject', () => {
  it('requireRead/requireWrite refuse before resolving access', async () => {
    const { registerInsightsSuiteRoutes } = await import('../src/features/insights-suite/routes.js');
    const { registerToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const { saveConfig, __clearToggleStore } = await import('../src/host/featureToggles/service.js');
    const { insightsSuiteFeature } = await import('../src/features/insights-suite/feature.js');
    const { openSqliteStorage } = await import('../src/storage/sqlite/index.js');
    const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
    initHostExtPersistence(openSqliteStorage(':memory:'));
    registerToggleDefault(insightsSuiteFeature.toggleDefault!);
    await __clearToggleStore();
    await saveConfig({ ...insightsSuiteFeature.toggleDefault!, status: 'on' }, 'authz-test');

    // Capture the two handlers the feature registers, then invoke them with a
    // request carrying NO userId and NO principal — the shape the fail-open branch
    // needs. Anything other than a refusal means the gate is decorative.
    const handlers: Record<string, (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>> = {};
    const app = {
      get: (path: string, h: never) => { handlers[`GET ${path}`] = h; },
      put: (path: string, h: never) => { handlers[`PUT ${path}`] = h; },
    };
    registerInsightsSuiteRoutes({ app } as never);

    for (const key of ['GET /v1/host/openwop-app/insights-suite/config', 'PUT /v1/host/openwop-app/insights-suite/config']) {
      const handler = handlers[key];
      expect(handler, `${key} was not registered`).toBeTruthy();
      let captured: { httpStatus?: number; code?: string } | undefined;
      await handler!(
        { tenantId: 'default', body: { principalUserId: 'u-ceo' } },
        { json: () => { throw new Error(`${key} answered a request with NO acting subject`); } },
        (err?: unknown) => { captured = err as { httpStatus?: number; code?: string }; },
      );
      expect(captured?.httpStatus, `${key} did not refuse an unauthenticated request`).toBe(404);
      expect(captured?.code).toBe('not_found');
    }
  });
});
