/**
 * Behavioural companion to `chain-branch-node-reachability.test.ts`.
 *
 * The ratchet proves the `value` port is WIRED. This proves the wiring actually
 * branches: for each of the four chains that shipped an unpopulated predicate
 * input, the REAL `ifNode` (from `packs/core.openwop.flow`) is driven with the
 * inputs the REAL scheduler builds (`buildGraph` / `freshSnapshot` /
 * `markCompleted` / `buildNodeInputs`, over the REAL expanded definition) from
 * the REAL upstream output shape, and must return `then` for a matching payload
 * and `else` for a non-matching one.
 *
 * Before the wiring fix BOTH cases returned `else` — which is exactly why a
 * structural check alone is not enough: `else` is a legitimate verdict, so the
 * failure looked like a decision rather than a defect.
 *
 * `ctx.inputs` is built by the executor's OWN rule (`executor/nodeCtxInputs.ts`
 * `resolveDeclaredInputs` + `buildNodeCtxInputs`, ADR 0597 §Correction 9), so
 * nothing here re-implements the executor. (Until wave 114 this file copied the
 * single-`input` unwrap line, from before that module was exported.)
 *
 * ROUTING is asserted for all four chains: each branch's outcome must reach the
 * node its `why` names, through the real `evaluateCondition` over its out-edges.
 * Until 2026-10-29 two chains routed INVERTED and this block covered only the
 * other two: TST-CCX-1 `marketing.ad-optimization` sent an out-of-guardrail
 * change to `autoApply`, skipping approval; TST-CCX-2
 * `support.sentiment-escalation` only logged high brand risk and escalated
 * benign messages (both authored in #2671). Their then/else edges were swapped.
 *
 * TST-CCC-2. Red when: `ifNode` stops deriving `branch` from the predicate; a
 * chain's predicate edge stops landing on the `value` port; the scheduler stops
 * routing a named-port edge to that port; the executor's ctx-inputs rule stops
 * passing the port map through; `evaluateCondition` stops honouring `eq`; or a
 * chain's branch edges stop reaching their target (e.g. its then/else edges are
 * swapped back).
 */
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandChain, getChain, loadWorkflowChainPacks, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildGraph, buildNodeInputs, evaluateCondition, freshSnapshot, markCompleted, type EdgeCondition } from '../src/executor/scheduler.js';
import { buildNodeCtxInputs, resolveDeclaredInputs } from '../src/executor/nodeCtxInputs.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const ROOT = join(__dirname, '..', '..', '..');

type IfOutputs = { branch: string; matched: boolean; value: unknown };
type IfNode = (ctx: { inputs: unknown; config: Record<string, unknown> }) => Promise<{ outputs: IfOutputs }>;
let ifNode: IfNode;
let loadErrors: unknown[] = [];

beforeAll(async () => {
  _resetChainRegistryForTest();
  loadErrors = loadWorkflowChainPacks({ roots: [join(ROOT, 'examples', 'workflow-chain-packs')] }).errors;
  ({ ifNode } = (await import(join(ROOT, 'packs', 'core.openwop.flow', 'index.mjs'))) as { ifNode: IfNode });
});

/** Expansion prefixes node ids (`<chain>_<expansionId>_<authored>`); match the tail. */
const authored = (id: string): string => id.slice(id.lastIndexOf('_') + 1);

function expanded(chainId: string): WorkflowDefinition {
  const entry = getChain(chainId);
  expect(entry, `${chainId} must be loaded`).toBeTruthy();
  return expandChain(entry!.chain, { deferred: true });
}

function nodeIdOf(def: WorkflowDefinition, authoredId: string): string {
  const n = def.nodes.find((x) => authored(x.nodeId) === authoredId);
  expect(n, `node '${authoredId}' missing from the expansion`).toBeTruthy();
  return n!.nodeId;
}

/** The branch node's `ctx.inputs`, as the scheduler builds them after its upstreams complete. */
function ctxInputs(def: WorkflowDefinition, branchId: string, upstreamOutputs: Record<string, unknown>): unknown {
  const graph = buildGraph(def);
  const snapshot = freshSnapshot(def);
  const inbound = graph.incoming.get(branchId) ?? [];
  expect(inbound.length, `${branchId} must have an inbound edge`).toBeGreaterThan(0);
  for (const e of inbound) markCompleted(e.sourceNodeId, upstreamOutputs, snapshot);
  const byPort = buildNodeInputs(branchId, graph, snapshot, {});
  // The executor's own rule (executor.ts calls exactly these two, with the run's bag).
  const node = def.nodes.find((n) => n.nodeId === branchId)!;
  return buildNodeCtxInputs(byPort, resolveDeclaredInputs(node.inputs, {}));
}

function configOf(def: WorkflowDefinition, nodeId: string): Record<string, unknown> {
  return (def.nodes.find((n) => n.nodeId === nodeId)!.config ?? {}) as Record<string, unknown>;
}

/** Targets the branch node's out-edges fire for these outputs (real evaluateCondition). */
function routedTargets(def: WorkflowDefinition, branchId: string, outputs: IfOutputs): string[] {
  return (def.edges ?? [])
    .filter((e) => e.sourceNodeId === branchId)
    .filter((e) => !e.condition || evaluateCondition(e.condition as EdgeCondition, outputs))
    .map((e) => authored(e.targetNodeId));
}

/** chainId, branch node, upstream node's REAL output shape, a matching + a non-matching
 *  payload, and the node each branch must land on per its `why` (TST-CCX-1/2 were
 *  inverted before 2026-10-29). */
const CASES: { chainId: string; node: string; match: Record<string, unknown>; miss: Record<string, unknown>; why: string; then: string; else: string }[] = [
  {
    chainId: 'marketing.ad-optimization',
    node: 'guard',
    // `core.ai.chatCompletion` outputs `{ content }` (packs/core.openwop.ai/index.mjs).
    match: { content: 'Shift budget 30%.\nWITHIN GUARDRAIL: no' },
    miss: { content: 'Shift budget 5%.\nWITHIN GUARDRAIL: yes' },
    why: 'a change outside the guardrail must route to human review, one inside it must auto-apply',
    then: 'review',
    else: 'autoApply',
  },
  {
    chainId: 'support.kb-answer',
    node: 'route',
    match: { content: 'Reset it in Settings.\nCONFIDENCE: high' },
    miss: { content: 'I am not sure.\nCONFIDENCE: low' },
    why: 'a high-confidence answer must be delivered, a low-confidence one must escalate',
    then: 'deliver',
    else: 'approveEscalation',
  },
  {
    chainId: 'support.sentiment-escalation',
    node: 'route',
    match: { content: 'sentiment: negative\nBRAND RISK: high' },
    miss: { content: 'sentiment: positive\nBRAND RISK: none' },
    why: 'a high brand-risk message must escalate, a benign one must only be logged',
    then: 'approveEscalation',
    else: 'log',
  },
  {
    chainId: 'starters.verified-webhook-router',
    node: 'route',
    // `core.openwop.http.webhook-verify` outputs `{ valid, family }`.
    match: { valid: true, family: 'stripe' },
    miss: { valid: false, family: 'stripe' },
    why: 'a webhook that verified must be forwarded, a forged one dropped',
    then: 'notify',
    else: 'drop',
  },
];

it('the chain packs load cleanly (otherwise every case below is vacuous)', () => {
  expect(loadErrors).toEqual([]);
});

// One case per chain: the label (the branch node decides) AND the landing (its
// out-edges route). The label alone was the pre-w67 hole: `else` is a legitimate
// verdict, and an inverted then/else edge pair passed a label-only check.
describe('every shipped branch node takes both branches and reaches the node its `why` names', () => {
  it.each(CASES)('$chainId :: $node — then → $then, else → $else', async ({ chainId, node, match, miss, why, then, else: elseTarget }) => {
    const def = expanded(chainId);
    const id = nodeIdOf(def, node);
    const config = configOf(def, id);
    const hit = await ifNode({ inputs: ctxInputs(def, id, match), config });
    const skip = await ifNode({ inputs: ctxInputs(def, id, miss), config });
    expect(hit.outputs.branch, `the matching payload must take \`then\` (${why})`).toBe('then');
    expect(skip.outputs.branch, `the non-matching payload must take \`else\` (${why})`).toBe('else');
    expect(routedTargets(def, id, hit.outputs), why).toEqual([then]);
    expect(routedTargets(def, id, skip.outputs), why).toEqual([elseTarget]);
  });
});
