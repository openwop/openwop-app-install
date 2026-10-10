/**
 * CSM↔CRM linkage packs (ADR 0212):
 *   - feature.csm.nodes `health-set` accepts `factors` (explicit, computed —
 *     which since ADR 0582 §15 MUST name its `method` rather than have
 *     `penalty-sum` invented for it) or a `deals`/`tasks` CRM fan-in (from which
 *     it derives a documented default healthScore + healthFactors, ADR 0212 §3,
 *     plus the §16 attribution-coverage denominators). ADR 0582 §4: the computed
 *     path REFUSES (recorded + typed) on a partial / unscopeable fan-in; CSM-8
 *     strict company filter; CSM-11 non-numeric score is a typed failure.
 *   - CSMUX-13: the agent prompt's health bands are pinned to the console SSoT.
 *   - examples/workflow-chain-packs/csm-ops — loads clean, freezes params
 *     (RFC 0013 Path A), WF-CSM-1 the gate gates, WF-CSM-2 the reviewer sees deals.
 * The node's manifest classification/version legs live in csm-node-replay.test.ts.
 *
 * SABOTAGE-WITNESSED (grade-tests w7, probes `w7g1-packs-*`): each formula term,
 * refusal branch, prompt band and chain edge above was broken in turn and the
 * case claiming it went red.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraph, buildNodeInputs, freshSnapshot, markCompleted } from '../src/executor/scheduler.js';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CSM_NODES_PACK_DIR = join(REPO_ROOT, 'packs', 'feature.csm.nodes');
const CRM_NODES_PACK_DIR = join(REPO_ROOT, 'packs', 'feature.crm.nodes');
const CHAIN_PACK_ROOT = join(REPO_ROOT, 'examples', 'workflow-chain-packs');

interface NodeManifestEntry {
  typeId: string;
  version: string;
  category: string;
  role: string;
}
interface NodesManifest {
  name: string;
  version: string;
  nodes: NodeManifestEntry[];
  runtime: { entry: string };
}

describe('feature.csm.nodes pack', () => {
  const manifest = JSON.parse(readFileSync(join(CSM_NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;

  // CSMUX-13 / CSMUX-9 — PROMPT-TO-SSoT PARITY. The health-insights agent's
  // system prompt used to say at-risk is `< 50` and critical `< 25`, while the
  // console renders healthy `>= 70` / at-risk `40-69` / critical `< 40` and the
  // "ARR at risk" tile counts `< 70`. The CTA that opens this agent sits on that
  // very page, beside that very facet — so an operator asking "which accounts
  // are at risk" got a DIFFERENT set than the screen showed, with nothing
  // reconciling them. `vendor.openwop-app.csm.agents` had ZERO tests, so nothing noticed.
  //
  // This is the ARCHITECTURE.md non-negotiable: text reaching a model is
  // generated from its SSoT or TEST-PINNED to it. `CsmPage.tsx`'s `healthTier`
  // is the SSoT; this pins the prompt to it in BOTH directions, so moving either
  // one alone goes red.
  it('CSMUX-13: the agent prompt states the SAME health bands the console renders', () => {
    const prompt = readFileSync(join(REPO_ROOT, 'packs', 'vendor.openwop-app.csm.agents', 'prompts', 'csm-health.md'), 'utf8');
    const page = readFileSync(
      join(REPO_ROOT, 'frontend', 'react', 'src', 'features', 'csm', 'CsmPage.tsx'), 'utf8',
    );
    // The console's boundaries, read from the source rather than restated here —
    // restating them is how the two drift in the first place.
    const tier = /return s >= (\d+) \? 'healthy' : s >= (\d+) \? 'at_risk' : 'critical';/.exec(page);
    expect(tier, 'the console tier function must be findable — otherwise this test is vacuous').toBeTruthy();
    // DERIVED, not restated: whatever the console says, the prompt must say.
    // Hard-coding 70/40 here would make this a pair of constants that drift
    // together with neither noticing the other.
    const [healthy, atRisk] = [tier![1]!, tier![2]!];

    expect(prompt).toContain(`\`>= ${healthy}\``);
    expect(prompt).toContain(`\`${atRisk}\`-\`${Number(healthy) - 1}\``);
    expect(prompt).toContain(`\`< ${atRisk}\``);
    // …and the OLD numbers must be gone, in both spellings.
    expect(prompt).not.toContain('`< 50`');
    expect(prompt).not.toContain('`< 25`');
  });

  it('health-set computes a documented default healthScore + healthFactors from a deals/tasks fan-in (ADR 0212 §3)', async () => {
    const mod = (await import(pathToFileURL(join(CSM_NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: { account: unknown } }>>;
    };
    const setHealth = vi.fn(async (args: unknown) => ({ account: { accountId: 'csm:1', ...(args as object) } }));
    const stubCsm = { setHealth, listAccounts: vi.fn() };
    const deals = [
      { dealId: 'd1', companyId: 'cmp:1', status: 'open' },
      { dealId: 'd2', companyId: 'cmp:1', status: 'won' }, // not open — excluded
      { dealId: 'd3', companyId: 'cmp:other', status: 'open' }, // different company — excluded
    ];
    const tasks = [
      { taskId: 't1', companyId: 'cmp:1', status: 'open' },
      { taskId: 't2', companyId: 'cmp:1', status: 'done' }, // done — excluded
    ];
    const ctx = { config: { accountId: 'csm:1', companyId: 'cmp:1' }, inputs: { deals, tasks }, features: { csm: stubCsm } };
    const out = await mod.nodes['feature.csm.nodes.health-set'](ctx);
    expect(out.status).toBe('success');
    const args = setHealth.mock.calls[0]![0] as { healthScore: number; factors: Array<{ factor: string; value: number; weight: number }> };
    // 1 open deal (weight 8) + 1 open task (weight 3) ⇒ 100 - 8 - 3 = 89.
    expect(args.healthScore).toBe(89);
    // ADR 0582 §16 — the last four are ATTRIBUTION COVERAGE, `weight: 0` so
    // they cannot move the score. They exist because the strict company filter
    // makes `openTasks: 0` the norm (Task.companyId is optional and the sibling
    // `create-task` never sets it), which is otherwise indistinguishable from a
    // measured zero. Here all 3 deals / 2 tasks DO carry a companyId, so
    // coverage is full and the zeros above are genuinely measured.
    expect(args.factors).toEqual([
      { factor: 'openDeals', weight: 8, value: 1 },
      { factor: 'openTasks', weight: 3, value: 1 },
      { factor: 'dealsAttributed', weight: 0, value: 3 },
      { factor: 'dealsSeen', weight: 0, value: 3 },
      { factor: 'tasksAttributed', weight: 0, value: 2 },
      { factor: 'tasksSeen', weight: 0, value: 2 },
    ]);
  });

  // ADR 0582 §16 — the case the coverage signal exists for: tasks that carry NO
  // companyId. `openTasks` is 0 exactly as when there are none open, so without
  // `tasksAttributed: 0` beside `tasksSeen: 3` the breakdown cannot distinguish
  // "this account has no open work" from "nothing here could be attributed".
  it('an UNATTRIBUTABLE tasks fan-in reports zero coverage, not a silent measured zero', async () => {
    const mod = (await import(pathToFileURL(join(CSM_NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string }>>;
    };
    const setHealth = vi.fn(async (args: unknown) => ({ account: { accountId: 'csm:1', ...(args as object) } }));
    const ctx = {
      config: { accountId: 'csm:1', companyId: 'cmp:1' },
      inputs: {
        deals: [{ dealId: 'd1', companyId: 'cmp:1', status: 'open' }],
        // What `feature.crm.nodes.create-task` actually produces: no companyId.
        tasks: [{ taskId: 't1', status: 'open' }, { taskId: 't2', status: 'open' }, { taskId: 't3', status: 'open' }],
      },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await mod.nodes['feature.csm.nodes.health-set'](ctx);
    const args = setHealth.mock.calls[0]![0] as { healthScore: number; factors: Array<{ factor: string; value: number }> };
    const by = (name: string): number => args.factors.find((f) => f.factor === name)!.value;
    expect(by('openTasks'), 'three OPEN tasks, none attributable ⇒ none scored').toBe(0);
    expect(by('tasksSeen'), 'but the node did see three').toBe(3);
    expect(by('tasksAttributed'), 'and none of them carried a companyId').toBe(0);
    // The score reflects the deal only — the unattributable tasks are neither
    // scored nor silently treated as absent.
    expect(args.healthScore).toBe(92);
  });

  it('health-set honors a `weights` config override', async () => {
    const mod = (await import(pathToFileURL(join(CSM_NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: { account: unknown } }>>;
    };
    const setHealth = vi.fn(async (args: unknown) => ({ account: args }));
    const ctx = {
      config: { accountId: 'csm:1', companyId: 'cmp:1', weights: { deals: 20, tasks: 0 } },
      inputs: { deals: [{ dealId: 'd1', companyId: 'cmp:1', status: 'open' }], tasks: [] },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await mod.nodes['feature.csm.nodes.health-set'](ctx);
    const args = setHealth.mock.calls[0]![0] as { healthScore: number };
    expect(args.healthScore).toBe(80); // 100 - 1*20 - 0*0
  });

  // ─── ADR 0582 §4 — the computed path REFUSES rather than defaults ──────
  //
  // Every leg below produced `status:'success'` with a stamped score before the
  // fix. The `100` cases are the load-bearing ones: `portfolioArrAtRisk` counts
  // `< 70`, so a measurement failure that scores 100 REMOVES that account's ARR
  // from the at-risk figure — the exec summary got quieter when measurement broke.

  async function loadNode(): Promise<(ctx: unknown) => Promise<{ status: string }>> {
    const manifest = JSON.parse(readFileSync(join(CSM_NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;
    const mod = (await import(pathToFileURL(join(CSM_NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string }>>;
    };
    return mod.nodes['feature.csm.nodes.health-set']!;
  }

  it('a PARTIAL fan-in is refused and RECORDED — it no longer scores the missing side as zero open rows', async () => {
    const healthSet = await loadNode();
    const setHealth = vi.fn(async (args: unknown) => ({ account: { accountId: 'csm:1', ...(args as object) } }));
    const ctx = {
      config: { accountId: 'csm:1', companyId: 'cmp:1' },
      // `deals` never arrived — exactly what the pre-2026 bare-edge wiring
      // produced, and what a skipped upstream node produces today.
      inputs: { tasks: [] },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await expect(healthSet(ctx)).rejects.toMatchObject({ code: 'validation_error' });
    // Pre-fix: ONE call carrying `healthScore: 100` + a factors array asserting
    // `openDeals: 0` — counts nobody observed. Now: one call that records the
    // REFUSAL and writes no score.
    expect(setHealth).toHaveBeenCalledTimes(1);
    const args = setHealth.mock.calls[0]![0] as { healthScore?: number; factors?: unknown; measureFailedReason?: string };
    expect(args.healthScore).toBeUndefined();
    expect(args.factors).toBeUndefined();
    expect(args.measureFailedReason).toContain('deals');
  });

  it('a fan-in with NO companyId is refused — an unscopeable measurement used to score a clean 100', async () => {
    const healthSet = await loadNode();
    const setHealth = vi.fn(async (args: unknown) => ({ account: { accountId: 'csm:1', ...(args as object) } }));
    const ctx = {
      config: { accountId: 'csm:1' }, // no companyId
      inputs: { deals: [{ dealId: 'd1', companyId: 'cmp:1', status: 'open' }], tasks: [] },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await expect(healthSet(ctx)).rejects.toMatchObject({ code: 'validation_error' });
    const args = setHealth.mock.calls[0]![0] as { healthScore?: number; measureFailedReason?: string };
    expect(args.healthScore).toBeUndefined();
    expect(args.measureFailedReason).toContain('companyId');
  });

  it('a genuinely EMPTY-but-complete fan-in still scores 100 — the fix distinguishes unmeasured from measured-zero', async () => {
    const healthSet = await loadNode();
    const setHealth = vi.fn(async (args: unknown) => ({ account: { accountId: 'csm:1', ...(args as object) } }));
    const ctx = {
      config: { accountId: 'csm:1', companyId: 'cmp:1' },
      inputs: { deals: [], tasks: [] }, // both arrived, both empty: a real zero
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    const out = await healthSet(ctx);
    expect(out.status).toBe('success');
    const args = setHealth.mock.calls[0]![0] as { healthScore: number; companyId: string; method: string };
    expect(args.healthScore).toBe(100);
    // ADR 0582 §4/§5 — the write names the company it measured and the arithmetic
    // it used; the service refuses it otherwise.
    expect(args.companyId).toBe('cmp:1');
    expect(args.method).toBe('penalty-sum');
  });

  it('CSM-8: an UNATTRIBUTED CRM row is no longer counted against every account', async () => {
    const healthSet = await loadNode();
    const setHealth = vi.fn(async (args: unknown) => ({ account: { accountId: 'csm:1', ...(args as object) } }));
    const ctx = {
      config: { accountId: 'csm:1', companyId: 'cmp:1' },
      // One org-wide task with no companyId used to deflate EVERY account at
      // once (`!t?.companyId || …`), while the pack claimed it "re-filters
      // locally by task.companyId".
      inputs: { deals: [], tasks: [{ taskId: 't1', status: 'open' }] },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await healthSet(ctx);
    const args = setHealth.mock.calls[0]![0] as { healthScore: number };
    expect(args.healthScore).toBe(100); // was 97
  });

  it('CSM-11: a non-numeric healthScore is a typed failure, not a success that wrote nothing', async () => {
    const healthSet = await loadNode();
    const setHealth = vi.fn(async (args: unknown) => ({ account: args }));
    // An embedded `{{params.healthScore}}` freezes to a STRING (RFC 0013 Path A).
    // The fixture carries a complete `factors` write (company + method), so a node
    // WITHOUT the CSM-11 guard would drop the string score and still reach
    // `setHealth` — this is what makes the case discriminate the guard rather
    // than the later "nothing to write" throw (w7 probe packs-csm11 was vacuous
    // on the bare `{ healthScore: '72' }` fixture).
    const ctx = {
      config: { accountId: 'csm:1', companyId: 'cmp:1', healthScore: '72' },
      inputs: { factors: [{ factor: 'custom', weight: 1, value: 72 }], method: 'weighted-mean' },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await expect(healthSet(ctx)).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('`healthScore` MUST be a number') });
    expect(setHealth, 'nothing may be written on the invalid-score path').not.toHaveBeenCalled();
  });

  it('a call with nothing to write fails typed instead of returning success', async () => {
    const healthSet = await loadNode();
    const setHealth = vi.fn(async (args: unknown) => ({ account: args }));
    const ctx = { config: { accountId: 'csm:1' }, inputs: {}, features: { csm: { setHealth, listAccounts: vi.fn() } } };
    await expect(healthSet(ctx)).rejects.toMatchObject({ code: 'validation_error' });
    expect(setHealth).not.toHaveBeenCalled();
  });

  it('health-set passes explicit `factors` through unchanged (no deals/tasks fan-in)', async () => {
    const mod = (await import(pathToFileURL(join(CSM_NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: { account: unknown } }>>;
    };
    const setHealth = vi.fn(async (args: unknown) => ({ account: args }));
    const explicitFactors = [{ factor: 'custom', weight: 1, value: 42 }];
    const ctx = {
      config: { accountId: 'csm:1' },
      // ADR 0582 §15 — the caller must NAME the arithmetic it used. This test
      // previously omitted `method` and still passed, because the node quietly
      // defaulted it to `penalty-sum`; that is what let a weighted-mean
      // breakdown ship mislabelled.
      inputs: { healthScore: 70, factors: explicitFactors, method: 'weighted-mean' },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await mod.nodes['feature.csm.nodes.health-set'](ctx);
    const args = setHealth.mock.calls[0]![0] as { healthScore: number; factors: unknown; method: string };
    expect(args.healthScore).toBe(70);
    expect(args.factors).toBe(explicitFactors);
    // The DECLARED method survives verbatim — it is not overwritten with the
    // node's own default.
    expect(args.method).toBe('weighted-mean');
  });

  // ADR 0582 §15 — the "invent rather than refuse" leg. Against the pre-fix
  // node this passed `method:'penalty-sum'` to the service and RESOLVED; the
  // SPA then rendered that fabricated arithmetic as a sentence describing a
  // breakdown it did not describe.
  it('health-set REFUSES an explicit `factors` breakdown that does not name its `method`', async () => {
    const mod = (await import(pathToFileURL(join(CSM_NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<unknown>>;
    };
    const setHealth = vi.fn(async (args: unknown) => ({ account: args }));
    const ctx = {
      config: { accountId: 'csm:1' },
      inputs: { healthScore: 70, factors: [{ factor: 'custom', weight: 1, value: 42 }] },
      features: { csm: { setHealth, listAccounts: vi.fn() } },
    };
    await expect(mod.nodes['feature.csm.nodes.health-set'](ctx)).rejects.toThrow(/refused to score/);
    // The refusal is RECORDED on the account (the `refuseToScore` shape), not
    // just thrown — an unmeasured account must not read as a healthy one.
    const recorded = setHealth.mock.calls.map((c) => c[0] as { measureFailedReason?: string });
    expect(recorded.some((a) => typeof a.measureFailedReason === 'string')).toBe(true);
    // ...and it never wrote a score.
    expect(recorded.some((a) => (a as { healthScore?: number }).healthScore !== undefined)).toBe(false);
  });
});

describe('examples/workflow-chain-packs/csm-ops', () => {
  // Every case below reads the chain registry; load it here so no case depends
  // on the 'loads through…' case having run first (red under --sequence.shuffle).
  beforeAll(() => {
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: [CHAIN_PACK_ROOT] });
  });

  it('loads through loadWorkflowChainPacks with zero errors and registers both chains', () => {
    _resetChainRegistryForTest();
    const { installed, errors } = loadWorkflowChainPacks({ roots: [CHAIN_PACK_ROOT] });
    expect(errors).toEqual([]);
    const mine = installed.find((p) => p.packName === 'core.openwop.workflows.csm-ops');
    expect(mine).toBeTruthy();
    expect(mine!.chainIds.sort()).toEqual(['csm-ops.health-from-crm', 'csm-ops.renewal-risk']);
    expect(getChain('csm-ops.health-from-crm')).not.toBeNull();
    expect(getChain('csm-ops.renewal-risk')).not.toBeNull();
    expect(listChains().some((c) => c.packName === 'core.openwop.workflows.csm-ops')).toBe(true);
  });

  it('every DAG node references a real, known typeId (no invented typeIds)', () => {
    const csmManifest = JSON.parse(readFileSync(join(CSM_NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;
    const crmManifest = JSON.parse(readFileSync(join(CRM_NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;
    const known = new Set([
      ...csmManifest.nodes.map((n) => n.typeId),
      ...crmManifest.nodes.map((n) => n.typeId),
      'core.chat.approvalGate',
      // ADR 0582 §1/§10 — the renewal-risk reject branch. `core.flow.noop` is a
      // real shipped node (`packs/core.openwop.flow`, exported at index.mjs and
      // declared in pack.json) used here as the labelled terminal for a
      // business rejection, replacing the `core.fail` that made every routine
      // "no" count as a run failure against the fleet success rate.
      'core.flow.noop',
    ]);
    for (const chainId of ['csm-ops.health-from-crm', 'csm-ops.renewal-risk']) {
      const entry = getChain(chainId)!;
      for (const n of entry.chain.dag.nodes) {
        expect(known.has(n.typeId), `${chainId}:${n.id} → ${n.typeId}`).toBe(true);
      }
    }
  });

  it('both chains expand to a frozen, validated WorkflowDefinition (RFC 0013)', () => {
    const healthDef = expandChain(getChain('csm-ops.health-from-crm')!.chain, {
      params: { orgId: 'org-1', companyId: 'cmp:1', accountId: 'csm:1' },
    });
    expect(healthDef.workflowId).toMatch(/^csm-ops\.health-from-crm:[0-9a-f]{12}$/);
    const write = healthDef.nodes.find((n) => n.typeId === 'feature.csm.nodes.health-set')!;
    expect((write.config as { accountId: string }).accountId).toBe('csm:1'); // RFC 0013 Path A: frozen at expansion
    expect((write.config as { companyId: string }).companyId).toBe('cmp:1');
    // Two fan-in edges into the health-write node.
    const incoming = (healthDef.edges ?? []).filter((e) => e.targetNodeId === write.nodeId);
    expect(incoming).toHaveLength(2);
    // Path A: required params declared on the CHAIN; expand freezes (no variables[]).
    expect(((getChain('csm-ops.health-from-crm')!.chain.parameters as { required?: string[] }).required)).toEqual(
      expect.arrayContaining(['orgId', 'companyId', 'accountId']),
    );
    const healthDefNoParams = expandChain(getChain('csm-ops.health-from-crm')!.chain, { params: {} });
    expect(healthDefNoParams.variables).toBeUndefined();
    expect(JSON.stringify(healthDefNoParams.nodes)).not.toContain('{{params');

    const riskDef = expandChain(getChain('csm-ops.renewal-risk')!.chain, { params: { orgId: 'org-1' } });
    expect(riskDef.workflowId).toMatch(/^csm-ops\.renewal-risk:[0-9a-f]{12}$/);
    expect(riskDef.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(true);
    const riskDefNoParams = expandChain(getChain('csm-ops.renewal-risk')!.chain, { params: {} });
    expect(riskDefNoParams.variables).toBeUndefined();
  });

  // ─── ADR 0582 §1 — the renewal-risk gate actually gates ────────────────
  //
  // These assert against the REAL expanded definition (loader → expandChain),
  // not the raw manifest, because expansion is what the executor runs.

  it('WF-CSM-1: the follow-up effect hangs off `truthy approved`, and the reject branch is a labelled terminal', () => {
    const def = expandChain(getChain('csm-ops.renewal-risk')!.chain, { params: { orgId: 'org-1' } });
    const id = (suffix: string): string => def.nodes.find((n) => n.nodeId.endsWith(suffix))!.nodeId;
    const toFollowUp = (def.edges ?? []).find((e) => e.targetNodeId === id('follow-up'))!;
    expect(toFollowUp, 'the CRM write must still be reachable').toBeTruthy();
    // `core.chat.approvalGate` returns success on reject too — WITHOUT this
    // condition a rejected review performs the action.
    expect(toFollowUp.condition).toEqual({ path: 'approved', op: 'truthy' });
    // ADR 0582 §10 — the reject leg was a `core.fail`. A reviewer's routine
    // "no" is a business OUTCOME, not a run failure, and `workflowFleetStats`
    // computes successRate as completed/(completed+failed) excluding only
    // debug/eval/draft runs — so every legitimate rejection degraded this
    // workflow's headline number. It is now a labelled `core.flow.noop`
    // terminal: the run COMPLETES, no task is written, and the rejection stays
    // auditable via the gate's own `decision:'reject'` output.
    expect(
      def.nodes.some((n) => n.typeId === 'core.fail'),
      'a routine business rejection must not be modelled as a run failure',
    ).toBe(false);
    const rejectNode = def.nodes.find((n) => n.nodeId.endsWith('gate-reject'));
    expect(rejectNode, 'the reject branch must still be an explicit, labelled node').toBeTruthy();
    expect(rejectNode!.typeId).toBe('core.flow.noop');
    const toReject = (def.edges ?? []).find((e) => e.targetNodeId === rejectNode!.nodeId)!;
    // RFC 0134: truthy/falsy take NO `right`, so the mapped host condition
    // carries no `value` — a stray one would be inert and is dropped.
    expect(toReject.condition).toEqual({ path: 'approved', op: 'falsy' });
    // The chain's declared output is `task`: the auto-primary is the LAST
    // terminal node in declaration order, so `gate-reject` must not steal it.
    expect(def.nodes.find((n) => n.outputRole === 'primary')?.nodeId).toBe(id('follow-up'));
  });

  it('WF-CSM-2: the reviewer sees the deals — the REAL buildNodeInputs puts them on `artifact`, not the default port', async () => {
    const def = expandChain(getChain('csm-ops.renewal-risk')!.chain, { params: { orgId: 'org-1' } });
    const reviewId = def.nodes.find((n) => n.typeId === 'core.chat.approvalGate')!.nodeId;
    const dealsId = def.nodes.find((n) => n.typeId === 'feature.crm.nodes.list-deals')!.nodeId;
    const deals = [{ dealId: 'd1', title: 'Renewal' }];
    // The REAL scheduler graph + snapshot of the expanded definition, with the
    // deals source marked completed exactly as the executor would.
    const graph = buildGraph(def);
    const snapshot = freshSnapshot(def);
    markCompleted(dealsId, { deals }, snapshot);
    const ports = buildNodeInputs(reviewId, graph, snapshot, {});
    // Pre-fix this was `{ input: { deals } }`, which the executor's single-key
    // unwrap then flattened to `{ deals }` — and the gate reads `inputs.artifact`.
    expect(Object.keys(ports)).toEqual(['artifact']);
    expect(ports.artifact).toEqual(deals);
    // No single-`input` key ⇒ the executor's back-compat unwrap does not fire,
    // so `ctx.inputs.artifact` is what the node sees.
    expect('input' in ports).toBe(false);
  });
});
