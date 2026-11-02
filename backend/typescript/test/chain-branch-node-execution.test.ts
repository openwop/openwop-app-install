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
 * HONEST CEILING: the executor's single-`input` unwrap (`executor.ts`, the line
 * after `buildNodeInputs` in the DAG loop) is not exported, so `ctxInputs` below
 * repeats that one rule. Everything else is the product's own code.
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
 * routing a named-port edge to that port; or a correctly-routed chain's branch
 * edges stop reaching their target (e.g. a chain's then/else edges are swapped).
 */
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandChain, getChain, loadWorkflowChainPacks, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildGraph, buildNodeInputs, evaluateCondition, freshSnapshot, markCompleted, type EdgeCondition } from '../src/executor/scheduler.js';
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
  // executor.ts: unwrap ONLY a lone port literally named `input` (the copied rule — see header).
  return Object.keys(byPort).length === 1 && 'input' in byPort ? byPort.input : byPort;
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

/** chainId, branch node, upstream node's REAL output shape, a matching + a non-matching payload. */
const CASES: { chainId: string; node: string; match: Record<string, unknown>; miss: Record<string, unknown>; why: string }[] = [
  {
    chainId: 'marketing.ad-optimization',
    node: 'guard',
    // `core.ai.chatCompletion` outputs `{ content }` (packs/core.openwop.ai/index.mjs).
    match: { content: 'Shift budget 30%.\nWITHIN GUARDRAIL: no' },
    miss: { content: 'Shift budget 5%.\nWITHIN GUARDRAIL: yes' },
    why: 'a change outside the guardrail must route to human review, one inside it must auto-apply',
  },
  {
    chainId: 'support.kb-answer',
    node: 'route',
    match: { content: 'Reset it in Settings.\nCONFIDENCE: high' },
    miss: { content: 'I am not sure.\nCONFIDENCE: low' },
    why: 'a high-confidence answer must be delivered, a low-confidence one must escalate',
  },
  {
    chainId: 'support.sentiment-escalation',
    node: 'route',
    match: { content: 'sentiment: negative\nBRAND RISK: high' },
    miss: { content: 'sentiment: positive\nBRAND RISK: none' },
    why: 'a high brand-risk message must escalate, a benign one must only be logged',
  },
  {
    chainId: 'starters.verified-webhook-router',
    node: 'route',
    // `core.openwop.http.webhook-verify` outputs `{ valid, family }`.
    match: { valid: true, family: 'stripe' },
    miss: { valid: false, family: 'stripe' },
    why: 'a webhook that verified must be forwarded, a forged one dropped',
  },
];

/** Where each branch must land, per its `why` (TST-CCX-1/2 were inverted before 2026-10-29). */
const ROUTES: { chainId: string; then: string; else: string }[] = [
  { chainId: 'marketing.ad-optimization', then: 'review', else: 'autoApply' },
  { chainId: 'support.kb-answer', then: 'deliver', else: 'approveEscalation' },
  { chainId: 'support.sentiment-escalation', then: 'approveEscalation', else: 'log' },
  { chainId: 'starters.verified-webhook-router', then: 'notify', else: 'drop' },
];

it('the chain packs load cleanly (otherwise every case below is vacuous)', () => {
  expect(loadErrors).toEqual([]);
});

describe('a shipped branch node reaches BOTH of its branches', () => {
  it.each(CASES)('$chainId :: $node — $why', async ({ chainId, node, match, miss }) => {
    const def = expanded(chainId);
    const id = nodeIdOf(def, node);
    const config = configOf(def, id);
    const hit = await ifNode({ inputs: ctxInputs(def, id, match), config });
    const skip = await ifNode({ inputs: ctxInputs(def, id, miss), config });
    expect(hit.outputs.branch, 'the matching payload must take `then`').toBe('then');
    expect(skip.outputs.branch, 'the non-matching payload must take `else`').toBe('else');
  });
});

describe('every shipped branch node reaches the node its `why` names', () => {
  it.each(ROUTES)('$chainId: then → $then, else → $else', async ({ chainId, then, else: elseTarget }) => {
    const c = CASES.find((x) => x.chainId === chainId)!;
    const def = expanded(chainId);
    const id = nodeIdOf(def, c.node);
    const config = configOf(def, id);
    const hit = await ifNode({ inputs: ctxInputs(def, id, c.match), config });
    const skip = await ifNode({ inputs: ctxInputs(def, id, c.miss), config });
    expect(routedTargets(def, id, hit.outputs)).toEqual([then]);
    expect(routedTargets(def, id, skip.outputs)).toEqual([elseTarget]);
  });
});
