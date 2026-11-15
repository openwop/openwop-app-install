/**
 * CC-CHAIN-6 + CC-CHAIN-3 — params-only chain runs must hand their nodes real input.
 *
 * CC-CHAIN-6 (observed 373d4863a, run 04d415cc): `marketing.content-repurposing`'s
 * `outline` node is a SOURCE `core.ai.chatCompletion` whose only data is
 * `{{params.sourceText}}` inside `systemPrompt`; with empty run inputs `toMessages`
 * returned `[]`, so the provider got a system prompt and no user turn and Anthropic
 * rejected it ("Provider rejected request", invalid_request). 19 shipped chains share
 * the shape. Fix: no messages + a system prompt ⇒ the system prompt becomes the single
 * user turn (no invented text); neither ⇒ a typed failure with no provider call.
 *
 * CC-CHAIN-3 (observed, run 2fab46d1): `market-intel.digest` / `.shift-digest` bound
 * `{{params.topic}}` to `discover.config.query`, which `aiDiscovery` never reads (it reads
 * `inputs.topic`), so a param-only run failed `inputs.topic is required`. Fix: bind the
 * declared input. (The voc/score stages still need content/context the chain does not
 * produce — reported separately, see the PR body.)
 *
 * Red before: the chatCompletion cases see `messages: []` reach callAI; the market-intel
 * expansion case finds no `inputs.topic` on `discover`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chatCompletion } from '../../../packs/core.openwop.ai/index.mjs';
import { expandChain } from '../src/host/workflowChainPackLoader.js';
import { buildNodeCtxInputs, resolveDeclaredInputs } from '../src/executor/nodeCtxInputs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Typed dynamic import (the accessibility-nodes pattern): the pack ships no declaration file.
type AiDiscovery = (ctx: unknown) => Promise<unknown>;
const discoveryUrl = new URL('../../../packs/vendor.myndhyve.market-intel-discovery/index.mjs', import.meta.url);
const { aiDiscovery } = (await import(path.resolve(fileURLToPath(discoveryUrl)))) as { aiDiscovery: AiDiscovery };
const chainOf = (pack: string, chainId: string) =>
  (JSON.parse(fs.readFileSync(path.resolve(here, `../../../examples/workflow-chain-packs/${pack}/pack.json`), 'utf8')) as { chains: Array<{ chainId: string }> })
    .chains.find((c) => c.chainId === chainId)!;

type Req = { messages: Array<{ role: string; content: string }>; systemPrompt?: string };

describe('CC-CHAIN-6 — chatCompletion never sends a request with no user turn', () => {
  it('a source node with only a system prompt sends it as the user turn', async () => {
    const calls: Req[] = [];
    const out = await chatCompletion({
      config: { systemPrompt: 'Outline the angles. Source: KickTodo turns a postponed goal into a plan.' },
      inputs: {},
      callAI: async (req: Req) => { calls.push(req); return { content: 'ok' }; },
    } as never);
    expect(out.status).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'Outline the angles. Source: KickTodo turns a postponed goal into a plan.' }]);
    expect(calls[0]!.systemPrompt).toBeUndefined();
  });

  it('real input keeps the system prompt as the system prompt (unchanged path)', async () => {
    const calls: Req[] = [];
    await chatCompletion({
      config: { systemPrompt: 'Be brief.' },
      inputs: { prompt: 'Hello' },
      callAI: async (req: Req) => { calls.push(req); return { content: 'ok' }; },
    } as never);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(calls[0]!.systemPrompt).toBe('Be brief.');
  });

  it('no input and no system prompt is a typed failure, with no provider call', async () => {
    let called = false;
    const out = await chatCompletion({ config: {}, inputs: {}, callAI: async () => { called = true; return { content: '' }; } } as never) as { status: string; error?: { code: string } };
    expect(called).toBe(false);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('invalid_inputs');
  });

  it('the real content-repurposing outline node, expanded with params, reaches the provider with a user turn', async () => {
    const def = expandChain(chainOf('marketing', 'marketing.content-repurposing') as never, { params: { sourceText: 'SOURCE-TEXT', orgId: 'o1', templateId: 't1' } });
    const outline = def.nodes.find((n) => n.nodeId.endsWith('_outline'))!;
    const calls: Req[] = [];
    await chatCompletion({ config: outline.config, inputs: buildNodeCtxInputs({ input: {} }, resolveDeclaredInputs(outline.inputs, {})), callAI: async (req: Req) => { calls.push(req); return { content: 'ok' }; } } as never);
    expect(calls[0]!.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls[0]!.messages)).toContain('SOURCE-TEXT');
  });
});

describe('CC-CHAIN-3 — market-intel digests bind the topic param to the input discovery reads', () => {
  for (const chainId of ['market-intel.digest', 'market-intel.shift-digest']) {
    it(`${chainId}: a params-only run hands discover inputs.topic`, async () => {
      const def = expandChain(chainOf('market-intel-digest', chainId) as never, { params: { topic: 'goal-planning apps', previous: '{}' } });
      const discover = def.nodes.find((n) => n.nodeId.endsWith('_discover'))!;
      const ctxInputs = buildNodeCtxInputs({ input: {} }, resolveDeclaredInputs(discover.inputs, {})) as Record<string, unknown>;
      expect(ctxInputs.topic).toBe('goal-planning apps');
      const calls: unknown[] = [];
      const out = await aiDiscovery({
        config: discover.config ?? {}, inputs: ctxInputs,
        callAI: async (req: unknown) => { calls.push(req); return { data: { urls: [], communities: [], searchQueries: [] } }; },
      }) as { status: string; error?: { message?: string } };
      expect(out.error?.message ?? '').not.toContain('inputs.topic is required');
      expect(calls.length).toBeGreaterThan(0);
    });
  }
});
