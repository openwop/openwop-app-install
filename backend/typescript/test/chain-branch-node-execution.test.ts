/**
 * Behavioural companion to `chain-branch-node-reachability.test.ts`.
 *
 * The ratchet proves the `value` port is WIRED. This proves the wiring actually
 * branches: for each of the four chains that shipped an unpopulated predicate
 * input, the REAL `ifNode` (from `packs/core.openwop.flow`) is driven with the
 * REAL expanded edges and the REAL upstream output shape, and must return
 * `then` for a matching payload and `else` for a non-matching one.
 *
 * Before the wiring fix BOTH cases returned `else` — which is exactly why a
 * structural check alone is not enough: `else` is a legitimate verdict, so the
 * failure looked like a decision rather than a defect.
 *
 * The input-building here is copied verbatim from `executor/scheduler.ts`
 * (`buildInputs`) and `executor/executor.ts` (the single-`input` unwrap), so a
 * pass means the real executor branches the same way.
 */
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getChain, loadWorkflowChainPacks, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';

const ROOT = join(__dirname, '..', '..', '..');

type IfNode = (ctx: { inputs: unknown; config: Record<string, unknown> }) => Promise<{ outputs: { branch: string } }>;
let ifNode: IfNode;

beforeAll(async () => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [join(ROOT, 'examples', 'workflow-chain-packs')] });
  expect(errors, 'the chain packs must load cleanly, or every case below is vacuous').toEqual([]);
  ({ ifNode } = (await import(join(ROOT, 'packs', 'core.openwop.flow', 'index.mjs'))) as { ifNode: IfNode });
});

/** `scheduler.ts`: a portless edge lands on `input`; a `node.port` edge on `port`. */
function targetPort(to: string): string {
  const dot = to.indexOf('.');
  return dot === -1 ? 'input' : to.slice(dot + 1);
}
function refNode(ref: string): string {
  const dot = ref.indexOf('.');
  return dot === -1 ? ref : ref.slice(0, dot);
}

/** Build the branch node's `ctx.inputs` exactly as the executor does. */
function buildCtxInputs(chainId: string, branchNodeId: string, upstreamOutputs: Record<string, unknown>): unknown {
  const chain = getChain(chainId)?.chain;
  expect(chain, `${chainId} must be loaded`).toBeTruthy();
  const dag = chain!.dag as { edges?: { from: string; to: string }[] };
  const inbound = (dag.edges ?? []).filter((e) => refNode(e.to) === branchNodeId);
  expect(inbound.length, `${chainId}/${branchNodeId} must have an inbound edge`).toBeGreaterThan(0);

  const byPort: Record<string, unknown> = {};
  for (const e of inbound) {
    const sourcePort = e.from.includes('.') ? e.from.slice(e.from.indexOf('.') + 1) : 'output';
    byPort[targetPort(e.to)] = Object.prototype.hasOwnProperty.call(upstreamOutputs, sourcePort)
      ? upstreamOutputs[sourcePort]
      : upstreamOutputs;
  }
  // `executor.ts`: unwrap ONLY a lone port literally named `input`.
  return Object.keys(byPort).length === 1 && 'input' in byPort ? byPort.input : byPort;
}

function configOf(chainId: string, nodeId: string): Record<string, unknown> {
  const dag = getChain(chainId)!.chain.dag as { nodes?: { id: string; config?: Record<string, unknown> }[] };
  return (dag.nodes ?? []).find((n) => n.id === nodeId)!.config ?? {};
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

describe('a shipped branch node reaches BOTH of its branches', () => {
  it.each(CASES)('$chainId :: $node — $why', async ({ chainId, node, match, miss }) => {
    const config = configOf(chainId, node);
    const hit = await ifNode({ inputs: buildCtxInputs(chainId, node, match), config });
    const skip = await ifNode({ inputs: buildCtxInputs(chainId, node, miss), config });
    expect(hit.outputs.branch, 'the matching payload must take `then`').toBe('then');
    expect(skip.outputs.branch, 'the non-matching payload must take `else`').toBe('else');
  });
});

describe('the regression this pins', () => {
  it('a portless edge leaves ctx.inputs.value undefined, so `then` becomes unreachable', async () => {
    // The pre-fix wiring, reproduced exactly: payload on `input`, nothing on `value`.
    const preFix = { content: 'WITHIN GUARDRAIL: no' }; // unwrapped lone `input` port
    const r = await ifNode({ inputs: preFix, config: configOf('marketing.ad-optimization', 'guard') });
    expect(r.outputs.branch, 'this is the silent failure the fix removes').toBe('else');
  });
});

describe('the node under test is the real pack implementation', () => {
  it('ifNode came from the flow pack, not a stub', () => {
    // The `beforeAll` import throws loudly on a bad path, so a resolution check
    // adds nothing (an earlier version of this file asserted `require.resolve`
    // on a shim the suite never used — a guard over the wrong mechanism).
    // What is worth pinning is that the imported symbol is the real node.
    expect(typeof ifNode, 'ifNode must be the pack export').toBe('function');
    expect(String(ifNode), 'the real impl reads ctx.inputs.value — a stub would not').toContain('ctx.config.predicate');
  });
});
