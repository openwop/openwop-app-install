/**
 * WF-FAIL-2 — no chain may let a FAILED node quietly skip an approval gate and
 * still finish as `completed`.
 *
 * The executor treats a failed middle node as recoverable: the run is
 * `completed` when every terminal node completed or was skipped
 * (`scheduler.inspectDisposition`). That is right for error-routing branches,
 * and wrong when the failure's only effect is to skip the human gate that
 * stood between the work and its consequences. The KickTodo factory shipped
 * exactly that: a failed lesson batch skipped its checkpoint gate and the run
 * went on to submit the challenge for publication (WF-FAIL-1, fixed with
 * `build-fail-N` barriers in #4902).
 *
 * This census drives the REAL scheduler (buildGraph / evaluateTrigger /
 * releaseDownstream / inspectDisposition) over every vendored chain, deferred-
 * expanded as it is seeded:
 *   1. a baseline run where every node succeeds and every gate approves —
 *      which gates run;
 *   2. for each non-gate, non-`core.fail` node F, the same run with F failing.
 * A violation is a failure run in which a gate the baseline ran was skipped
 * AND a node downstream of that gate (work the gate guards) still ran — the
 * WF-FAIL-1 shape (a failed batch skipped its checkpoint, and decompose +
 * submit-publication ran anyway). `core.fail` barriers are not counted.
 *
 * Conditions are evaluated against an output in which every field is `true`
 * (gates approve, live-slot flags are on), so a `falsy` edge (a reject route)
 * never fires and a `truthy` one always does — the happy path the gate guards.
 *
 * The violating set is pinned and may only SHRINK. Sabotage: deleting the
 * KickTodo factory's `build-fail-N` edges adds `kicktodo.challenge-factory`
 * rows (decompose and the publication submit run past a skipped gate) and reds
 * the ratchet.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildGraph, freshSnapshot, inspectDisposition, markCompleted, markFailed, popReady, releaseDownstream } from '../src/executor/scheduler.js';
import { APPROVAL_GATE_TYPE_IDS } from '../src/host/approvalGateTypeIds.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

const bareType = (typeId: string): string => typeId.replace(/@[^@]+$/, '');
/** Every field reads `true`: gates approve, live flags are on. */
const ALL_TRUE: Record<string, unknown> = new Proxy({}, { get: () => true, has: () => true });

/** Run the real scheduler to quiescence; `failing` fails, everything else succeeds. */
function simulate(def: WorkflowDefinition, failing: string | null): { status: string | null; ran: Set<string> } {
  const graph = buildGraph(def);
  const snapshot = freshSnapshot(def);
  const ran = new Set<string>();
  for (let guard = 0; guard < 10_000; guard++) {
    const ready = popReady(64, snapshot);
    if (ready.length === 0) {
      const d = inspectDisposition(snapshot, graph, 0);
      if (d.done || !d.status) return { status: d.status, ran };
      continue;
    }
    for (const id of ready) {
      ran.add(id);
      // `core.fail` always fails — that is what makes it a barrier.
      const alwaysFails = bareType(def.nodes.find((x) => x.nodeId === id)!.typeId) === 'core.fail';
      if (id === failing || alwaysFails) markFailed(id, { code: 'simulated', message: 'simulated' }, snapshot);
      else markCompleted(id, ALL_TRUE, snapshot);
      releaseDownstream(id, graph, snapshot);
    }
  }
  throw new Error(`${def.workflowId}: simulation did not settle`);
}

/** Every node reachable from `from` along edges (what the gate guards). */
function downstreamOf(def: WorkflowDefinition, from: string): Set<string> {
  const graph = buildGraph(def);
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    for (const e of graph.outgoing.get(queue.shift()!) ?? []) {
      if (!seen.has(e.targetNodeId)) { seen.add(e.targetNodeId); queue.push(e.targetNodeId); }
    }
  }
  return seen;
}

function violations(): string[] {
  const out: string[] = [];
  for (const { chain } of listChains()) {
    const def = expandChain(chain, { deferred: true });
    const gates = new Set(def.nodes.filter((n) => APPROVAL_GATE_TYPE_IDS.has(bareType(n.typeId))).map((n) => n.nodeId));
    if (gates.size === 0) continue;
    const base = simulate(def, null);
    const baseGates = [...gates].filter((g) => base.ran.has(g));
    if (baseGates.length === 0) continue;
    for (const n of def.nodes) {
      if (gates.has(n.nodeId) || bareType(n.typeId) === 'core.fail' || !base.ran.has(n.nodeId)) continue;
      const run = simulate(def, n.nodeId);
      const strip = (id: string): string => id.slice(id.lastIndexOf('_') + 1);
      for (const g of baseGates.filter((x) => !run.ran.has(x))) {
        // The gate was skipped — did anything it guards run anyway?
        const leaked = [...downstreamOf(def, g)].filter((d) => run.ran.has(d) && bareType(def.nodes.find((x) => x.nodeId === d)!.typeId) !== 'core.fail');
        for (const d of leaked) out.push(`${chain.chainId} :: ${strip(n.nodeId)} fails -> ${strip(g)} skipped but ${strip(d)} ran`);
      }
    }
  }
  return [...new Set(out)].sort();
}

/** Bypasses that are safe because the guarded node REFUSES to act without the
 *  gate's approval in its own code — each is proven by the case below, so an
 *  entry here cannot outlive the guard it names. */
const GUARDED_IN_NODE: Record<string, string> = {
  'app-builder.repair :: audit fails -> review skipped but apply ran':
    'apply-repair fails approval_required when its `approval` input is absent (ADR 0835 D5)',
};

/** Pinned violating set (shrink-only). Each entry is a chain where a failing
 *  node skips a gate and the run still completes. Fix a chain with a failure
 *  route (a `core.fail` barrier reached by `any_failed`), then delete its rows. */
const BASELINE: string[] = [];

describe('WF-FAIL-2 — a failed node never silently skips an approval gate', () => {
  beforeAll(() => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
    expect(errors).toEqual([]);
  });

  it('the simulator is not vacuous: it sees gates and runs them on the happy path', () => {
    let chainsWithGates = 0;
    for (const { chain } of listChains()) {
      const def = expandChain(chain, { deferred: true });
      if (def.nodes.some((n) => APPROVAL_GATE_TYPE_IDS.has(bareType(n.typeId)))) chainsWithGates++;
    }
    expect(chainsWithGates).toBeGreaterThan(10);
  });

  it('the violating set only shrinks', () => {
    const now = violations().filter((v) => !(v in GUARDED_IN_NODE));
    const added = now.filter((v) => !BASELINE.includes(v));
    expect(added, `new gate bypasses on failure:\n${added.join('\n')}`).toEqual([]);
    const fixed = BASELINE.filter((v) => !now.includes(v));
    expect(fixed, `these are fixed — delete them from BASELINE:\n${fixed.join('\n')}`).toEqual([]);
  });

  it('each GUARDED_IN_NODE entry is still guarded: the node refuses without an approval', async () => {
    const appBuilder = (await import(new URL('../../../packs/feature.app-builder.nodes/index.mjs', import.meta.url).href)) as {
      nodes: Record<string, (ctx: Record<string, unknown>) => Promise<{ status?: string; error?: { code?: string } }>>;
    };
    const apply = appBuilder.nodes['feature.app-builder.nodes.apply-repair']!;
    let code: string | undefined;
    let wrote = false;
    try {
      const out = await apply({
        inputs: { artifact: { payload: { components: [] } }, canvasId: 'c', baseVersion: 1 },
        features: { 'app-builder': { applyRepair: async () => { wrote = true; return {}; } } },
      });
      code = out.error?.code;
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('approval_required');
    expect(wrote).toBe(false);
    expect(Object.keys(GUARDED_IN_NODE)).toHaveLength(1);
  });

  // The replan chain is the WF-FAIL-2 finding this ratchet was written for:
  // a failed `enrich` used to skip the participant's approval gate and `apply`
  // still changed their plan. Named here so a regression reads as what it is.
  it('kicktodo.replan: a failed enrich never applies an unapproved revision', () => {
    expect(violations().filter((v) => v.startsWith('openwop-app.kicktodo.replan '))).toEqual([]);
  });
});
