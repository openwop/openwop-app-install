/**
 * market-intel-digest workflow-chain pack — REAL execution (RFC 0013, ADR
 * 0149/0150/0174).
 *
 * CHAIN CHOSEN: `market-intel.digest` (`discover` → `voc` → `score` →
 * `synthesize`) — the more foundational of the pack's two chains
 * (`market-intel.shift-digest` layers a `market-intel.shift-detect` diff
 * step on the SAME `discover`→`voc`→`score` spine and would hit the
 * identical finding below).
 *
 * MODE CHOSEN: a hand-rolled mini-scheduler (the `cms-chain-execution.
 * test.ts` precedent), NOT the real executor. Every node in this chain —
 * `discover`, `voc`, `score`, AND `synthesize` — is itself an AI call
 * (`market-intel.ai-discovery` / `-voc-extraction` / `-opportunity-scoring`
 * all call `ctx.callAI` directly; `synthesize` is `core.ai.chatCompletion`),
 * so a real-executor honest-failure run would die at the very FIRST node
 * with nothing else to observe. The mini-scheduler walks the REAL node
 * implementations (`packs/vendor.myndhyve.market-intel-*`) with the SAME
 * edge port-resolution semantics `buildNodeInputs` uses, faking ONLY
 * `ctx.callAI` (captured, so the fake's captured message content proves the
 * REAL run.inputs `topic` genuinely threads into the AI discovery prompt —
 * not a canned/ignored value).
 *
 * GENUINE DEFECT FOUND — DOCUMENTED, NOT FIXED (out of scope for a wiring
 * fix; needs a design decision, not a pack.json edge/config change):
 * `market-intel.voc-extraction` (`packs/vendor.myndhyve.market-intel-voc/
 * index.mjs`) hard-requires `inputs.content` (a non-empty string of raw
 * text to extract voice-of-customer signals FROM), `inputs.icpContext`, and
 * `inputs.productContext` (both objects) — returning `{status:'error',
 * error:{code:'INVALID_INPUTS', ...}}` (a normal return value, not a throw)
 * when any is absent. The chain's `voc` node has an EMPTY `config` and a
 * SINGLE inbound edge from `discover` (no dot-notation, so the executor's
 * back-compat unwrap hands `voc` `discover`'s raw output object —
 * `{sources, communities, searchQueries, warnings, model, usage, success}`
 * — directly as `ctx.inputs`). NONE of `content`/`icpContext`/
 * `productContext` are anywhere in that shape, and the chain declares no
 * parameter for any of them either (`parameters.properties` = `topic`,
 * `audience` only) — `discover` only DISCOVERS candidate sources/
 * communities/search queries, it never fetches their content, and this
 * chain has no separate fetch step. So `voc` genuinely, reproducibly fails
 * with `INVALID_INPUTS` on every real run, immediately after `discover`
 * completes — this is a structural incompleteness in the shipped chain
 * (it needs a content-fetch node plus `icpContext`/`productContext`
 * chain parameters wired in), not a multi-fan-in port collision (BUG
 * PATTERN A — `voc` has only one inbound edge) or a missing-`orgId`
 * gap (BUG PATTERN B — this pack reads no org-scoped feature surface at
 * all). Fixing it would mean inventing a fetch step and two new
 * parameters' semantics unilaterally, which is a product decision beyond
 * this pass's wiring-bug mandate — recorded here instead, and the test
 * below asserts the REAL, reproducible failure rather than papering over
 * it.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getChain, expandChain, loadWorkflowChainPacks, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface NodeResult { status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }
type NodeImpl = (ctx: Record<string, unknown>) => Promise<NodeResult>;
let nodeImpls: Record<string, NodeImpl>;

beforeAll(async () => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs')] });
  expect(errors).toEqual([]);
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const discovery = (await import('../../../packs/vendor.myndhyve.market-intel-discovery/index.mjs')) as { default: Record<string, NodeImpl> };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const voc = (await import('../../../packs/vendor.myndhyve.market-intel-voc/index.mjs')) as { default: Record<string, NodeImpl> };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const scoring = (await import('../../../packs/vendor.myndhyve.market-intel-opportunity-scoring/index.mjs')) as { default: Record<string, NodeImpl> };
  const ai = (await import('../../../packs/core.openwop.ai/index.mjs')) as { nodes: Record<string, NodeImpl> };
  nodeImpls = { ...discovery.default, ...voc.default, ...scoring.default, ...ai.nodes };
});

/** Resolve `{{inputs.name}}` config tokens from the run params — mirrors the
 *  real executor's per-run variable interpolation (`interpolateRunInputs`). */
function resolveConfig(config: Record<string, unknown> | undefined, params: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [
    k,
    typeof v === 'string' ? v.replace(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => params[name] ?? '') : v,
  ]));
}

interface RunResult { results: Record<string, NodeResult>; capturedAiCalls: Array<{ nodeId: string; args: Record<string, unknown> }> }

/** Walk the expanded definition in edge order with `buildNodeInputs` port
 *  semantics (`sourceOutput` picks a field off the upstream node's outputs;
 *  `targetInput` names the ctx.inputs key it lands on; a single-key 'input'
 *  result unwraps to the raw upstream value — the executor's back-compat
 *  rule), calling the REAL node implementations with a FAKE ctx.callAI. */
async function runChain(chainId: string, params: Record<string, string>): Promise<RunResult> {
  const chain = getChain(chainId)!.chain;
  const def = expandChain(chain, { params });
  const outputs = new Map<string, Record<string, unknown>>();
  const results: Record<string, NodeResult> = {};
  const capturedAiCalls: Array<{ nodeId: string; args: Record<string, unknown> }> = [];
  const callAI = async (args: Record<string, unknown>) => {
    capturedAiCalls.push({ nodeId: 'unknown', args });
    return { content: JSON.stringify({ urls: ['https://example.com/thread-1'], communities: [{ platform: 'reddit', name: 'r/ops', url: 'https://reddit.com/r/ops', relevanceScore: 0.8, estimatedPostCount: 120, description: 'Ops discussion' }], searchQueries: ['topic pain points'] }) };
  };
  for (const node of def.nodes) {
    const incoming = (def.edges ?? []).filter((e) => e.targetNodeId === node.nodeId);
    // A source node (no incoming edges) gets the run's raw top-level inputs
    // directly — the real executor's `buildNodeInputs` returns `{input:
    // runInputs}` for such nodes, which the single-key "Back-compat" unwrap
    // (`executor.ts`) then collapses to `runInputs` itself.
    let ctxInputs: unknown = params;
    if (incoming.length > 0) {
      const inputs: Record<string, unknown> = {};
      for (const e of incoming) {
        const src = outputs.get(e.sourceNodeId) ?? {};
        const sourcePort = e.sourceOutput ?? 'output';
        const value = Object.prototype.hasOwnProperty.call(src, sourcePort) ? src[sourcePort] : src;
        inputs[e.targetInput ?? 'input'] = value;
      }
      ctxInputs = Object.keys(inputs).length === 1 && 'input' in inputs ? inputs.input : inputs;
    }
    const impl = nodeImpls[node.typeId];
    expect(impl, `node impl for ${node.typeId}`).toBeTruthy();
    const result = await impl!({ inputs: ctxInputs, config: resolveConfig(node.config, params), callAI });
    const short = node.nodeId.slice(node.nodeId.lastIndexOf('_') + 1);
    results[short] = result;
    if (result.status !== 'success') break;
    outputs.set(node.nodeId, result.outputs ?? {});
  }
  return { results, capturedAiCalls };
}

describe('market-intel.digest — end-to-end execution (mini-scheduler, real nodes, fake ctx.callAI)', () => {
  it('threads the real topic into discovery, then fails cleanly + reproducibly at voc (INVALID_INPUTS — a real, documented chain incompleteness)', async () => {
    const params = { topic: 'AI workflow orchestration for mid-market ops teams', audience: '' };
    const { results, capturedAiCalls } = await runChain('market-intel.digest', params);

    // discover ran for real: the fake callAI's prompt genuinely contains the
    // run's topic (not a canned/ignored value), and discover's REAL output-
    // validation logic shaped the fake JSON into the documented success shape.
    expect(results.discover?.status).toBe('success');
    expect(capturedAiCalls.length).toBe(1);
    const sentMessages = capturedAiCalls[0]!.args.messages as Array<{ content: string }>;
    expect(sentMessages[0]!.content).toContain('AI workflow orchestration for mid-market ops teams');
    expect(results.discover?.outputs?.sources).toEqual(['https://example.com/thread-1']);
    expect((results.discover?.outputs?.communities as unknown[]).length).toBe(1);

    // voc genuinely, reproducibly fails — the documented incompleteness above.
    expect(results.voc?.status).toBe('error');
    expect(results.voc?.error?.code).toBe('INVALID_INPUTS');

    // The chain never got anywhere near score/synthesize.
    expect(results.score).toBeUndefined();
    expect(results.synthesize).toBeUndefined();
  });
});
