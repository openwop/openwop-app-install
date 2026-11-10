/**
 * ADR 1016 D4b (code grade MR66CD-7) — this turn's route reaches the TOOL LOOP, and a
 * routed model the key cannot serve degrades once there too.
 *
 * The per-turn exchange test drives an agent-less exchange, which only reaches
 * `dispatchReply`; the BYOK tool loop is the other lane a chat turn dispatches on.
 * Only the provider adapter and the key are stubbed.
 *
 * Breaks if `runConversationAgentToolTurn` stops passing `route` to the resolver
 * (the loop would call the conversation's own model), or if the loop's degrade
 * target is computed with the route still in it (a routed 404 would fail the turn
 * instead of answering on the conversation's own model).
 *
 * Sabotage-witnessed (wave 82): `route: null` in the loop's target input reds
 * cases 1 and 3; computing `loopFallbackModel` with the route still in it, or
 * reporting `served` as the routed model instead of `modelUsed`, reds case 3.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const models: string[] = [];
let failModel: string | null = null;
vi.mock('../src/aiProviders/aiProvidersHost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aiProviders/aiProvidersHost.js')>();
  return {
    ...actual,
    createAiProvidersAdapter: vi.fn(() => ({
      callAIWithTools: vi.fn(async (req: { model: string }) => {
        models.push(req.model);
        if (req.model === failModel) throw Object.assign(new Error('model not available for this key'), { code: 'model_not_supported' });
        return { content: `answered by ${req.model}`, toolCalls: [] };
      }),
    })),
  };
});
vi.mock('../src/byok/secretResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/byok/secretResolver.js')>();
  return { ...actual, resolveSecret: vi.fn(async () => 'test-key') };
});

import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';
import type { RunRecord } from '../src/types.js';

const OWN = 'claude-haiku-4-5';
const BIG = 'claude-opus-5-5';
const run: RunRecord = {
  runId: 'r-adr1016-loop', workflowId: 'wf', tenantId: 'tenant-adr1016-loop', status: 'running',
  inputs: { provider: 'anthropic', model: OWN, credentialRef: 'byok:anthropic' }, metadata: {}, configurable: {},
  createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z',
};
// `toolAllowlist: []` still compiles tools: the ADR 0315 default-on baseline is added.
const agent: ResolvedAgentManifest = {
  agentId: 'a', persona: 'P', modelClass: 'chat', systemPrompt: 'sp', toolAllowlist: [],
  packName: 'core.openwop.test', packVersion: '0',
};
const policyResolver: ProviderPolicyResolver = { resolveForRun: async () => [] };
const turn = (route: { provider: string; model: string } | null) => runConversationAgentToolTurn({
  run, agent,
  systemPrompt: 'sp', history: [], runId: run.runId, nodeId: 'n', conversationId: 'c',
  policyResolver,
  route,
});

let reset: () => void = () => {};
beforeAll(async () => {
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
});
afterAll(() => reset());

describe('ADR 1016 — the BYOK tool loop honours this turn\'s route', () => {
  it('dispatches the ROUTED model and reports it as what answered', async () => {
    models.length = 0; failModel = null;
    const out = await turn({ provider: 'anthropic', model: BIG });
    expect(out, 'the loop ran (tools compiled)').not.toBeNull();
    expect(models).toEqual([BIG]);
    expect(out?.served).toEqual({ provider: 'anthropic', model: BIG });
  });

  it('CONTROL: with no route it dispatches the conversation\'s own model', async () => {
    models.length = 0; failModel = null;
    const out = await turn(null);
    expect(out, 'the loop ran (tools compiled)').not.toBeNull();
    expect(models).toEqual([OWN]);
    expect(out?.served).toEqual({ provider: 'anthropic', model: OWN });
  });

  it('a routed model the key cannot serve degrades ONCE to the conversation\'s own model', async () => {
    models.length = 0; failModel = BIG;
    const out = await turn({ provider: 'anthropic', model: BIG });
    expect(out, 'the loop ran (tools compiled)').not.toBeNull();
    expect(models).toEqual([BIG, OWN]);
    expect(out?.served).toEqual({ provider: 'anthropic', model: OWN });
    expect(out?.error).toBeUndefined();
  });
});
