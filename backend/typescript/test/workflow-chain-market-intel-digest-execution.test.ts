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
 * this pass's wiring-bug mandate — recorded here instead.
 *
 * HOW IT IS PINNED NOW (/grade-tests 8f W5, grade-code row MKTI-VOC-1): the file
 * used to assert `voc` → `INVALID_INPUTS` as the EXPECTED outcome, which blessed
 * the defect (a fix would have turned it red). It is now two cases:
 *   1. the correct behaviour that holds today — `discover` threads the run's
 *      `topic` into its AI prompt and shapes the reply (8fw5g6-mi-topic);
 *   2. `it.fails('… (MKTI-VOC-1)')` asserting the CORRECT outcome — `voc`
 *      succeeds on the chain's own wiring. It passes while the defect is live and
 *      turns red when it is fixed (fix-probe 8fw5g6-mi-voc-fix-r2 supplies the
 *      three inputs `voc` requires). Defect sites:
 *      `packs/vendor.myndhyve.market-intel-voc/index.mjs:247-265` (the required
 *      `content` / `icpContext` / `productContext`) and
 *      `examples/workflow-chain-packs/market-intel-digest/pack.json:39` (the
 *      `voc` node: empty config, one inbound edge from `discover`, no params).
 * The mini-scheduler below MIRRORS the executor's port semantics; it does not
 * test them (the scheduler's own tests do).
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
  it('threads the real topic into discovery, and discover shapes the reply into its documented outputs', async () => {
    const params = { topic: 'AI workflow orchestration for mid-market ops teams', audience: '' };
    const { results, capturedAiCalls } = await runChain('market-intel.digest', params);

    // discover ran for real: the fake callAI's prompt genuinely contains the
    // run's topic (not a canned/ignored value), and discover's REAL output-
    // validation logic shaped the fake JSON into the documented success shape.
    expect(results.discover?.status).toBe('success');
    // MKTI-VOC-1: rises to at least 2 when voc reaches the AI (then score / synthesize
    // add theirs) — update with the fix, alongside the ratchet's KNOWN entry.
    expect(capturedAiCalls.length).toBe(1);
    const sentMessages = capturedAiCalls[0]!.args.messages as Array<{ content: string }>;
    expect(sentMessages[0]!.content).toContain('AI workflow orchestration for mid-market ops teams');
    expect(results.discover?.outputs?.sources).toEqual(['https://example.com/thread-1']);
    expect(results.discover?.outputs?.communities).toHaveLength(1);
    expect(results.discover?.outputs?.searchQueries).toEqual(['topic pain points']);
  });

  it.fails('voc succeeds on the chain\'s own wiring — needs a content-fetch step + icp/product params (MKTI-VOC-1)', async () => {
    const params = { topic: 'AI workflow orchestration for mid-market ops teams', audience: '' };
    const { results } = await runChain('market-intel.digest', params);
    expect(results.discover?.status).toBe('success'); // the defect is downstream of a working discover
    expect(results.voc?.status, JSON.stringify(results.voc?.error)).toBe('success');
  });
});
