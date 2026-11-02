/**
 * ADR 1003 D3 — the `cacheConversation` hint reaches the dispatcher on every
 * continuation round, and never reaches the ADR 1002 replay digest.
 *
 * The hint is how the chat loop tells an Anthropic dispatcher "this round
 * repeats the last one's prefix". It rides `AiToolCallRequest`, which is also
 * what `toolsRoundDigest` reads. If the digest ever picked the field up, a
 * replay fork of a round that differs only in the hint would miss its record
 * and call the model live. That is the failure this file pins, through the
 * real adapter, the real replay lane and the real `runChatToolLoop`; only the
 * two provider dispatchers are mocked, and `fetch` throws.
 *
 * Sabotage (witnessed 2026-10-29): adding `cacheConversation` to
 * `toolsRoundDigest`'s preimage reds both "served across the hint" cases; not
 * setting the hint in `runChatToolLoop` reds both threading cases; dropping it
 * in the adapter reds the BYOK threading case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiToolCallRequest } from '../src/executor/types.js';

const TOOL_NAME = 'demo_read';
const TOOL_RESULT = 'TOOL_RESULT';

/** Round 1 asks for the tool; once its result is in the history, it answers. */
function scriptedRound(messages: unknown): { text: string; toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> } {
  return JSON.stringify(messages).includes(TOOL_RESULT)
    ? { text: 'The answer is 42.', toolUses: [] }
    : { text: '', toolUses: [{ id: 'tu-1', name: TOOL_NAME, input: { q: 'meaning' } }] };
}

const managedRound = vi.fn(async (req: { messages: unknown; cacheConversation?: boolean }) => ({ ...scriptedRound(req.messages), inputTokens: 10, outputTokens: 3 }));
const anthropicRound = vi.fn(async (req: { messages: unknown; cacheConversation?: boolean }) => ({ ...scriptedRound(req.messages), inputTokens: 20, outputTokens: 4, finishReason: 'end_turn' }));

vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return { ...original, dispatchManagedToolsRound: managedRound };
});
vi.mock('../src/providers/dispatchAnthropicTools.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatchAnthropicTools.js')>();
  return { ...original, dispatchAnthropicToolsRound: anthropicRound };
});

type Adapter = ReturnType<typeof import('../src/aiProviders/aiProvidersHost.js')['createAiProvidersAdapter']>;
let createAdapter: typeof import('../src/aiProviders/aiProvidersHost.js')['createAiProvidersAdapter'];
let beginNodeActivity: typeof import('../src/host/effectIdentity.js')['beginNodeActivity'];
let runChatToolLoop: typeof import('../src/host/agentDispatch.js')['runChatToolLoop'];
let policyResolver: import('../src/host/index.js').HostAdapterSuite['providerPolicyResolver'];
let app: Awaited<ReturnType<typeof import('../src/index.js')['createApp']>>;

const NODE = 'agent';
const TENANT = 'host-shared';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const { createApp } = await import('../src/index.js');
  ({ createAiProvidersAdapter: createAdapter } = await import('../src/aiProviders/aiProvidersHost.js'));
  ({ beginNodeActivity } = await import('../src/host/effectIdentity.js'));
  ({ runChatToolLoop } = await import('../src/host/agentDispatch.js'));
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0', enableConsoleTracer: false });
  policyResolver = (app.locals.hostSuite as import('../src/host/index.js').HostAdapterSuite).providerPolicyResolver;
});
afterAll(async () => {
  await (app.locals.storage as { close: () => Promise<void> }).close();
  delete process.env.OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE;
});

beforeEach(() => {
  managedRound.mockClear();
  anthropicRound.mockClear();
  process.env.OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE = 'true';
  const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ADR 1003 test: no live network call is allowed'));
  return () => spy.mockRestore();
});

function adapterFor(runId: string, byok: boolean, replayFrom?: string): Adapter {
  return createAdapter({
    runId, nodeId: NODE, tenantId: TENANT, attempt: 1,
    secrets: byok ? { anthropic: 'sk-test' } : {},
    policyResolver,
    ...(replayFrom ? { replayInvocationsFromRunId: replayFrom } : {}),
    emit: async () => ({ eventId: 'e', sequence: 1 }),
  });
}

const reqFor = (byok: boolean): AiToolCallRequest => ({
  provider: byok ? 'anthropic' : 'openwop-free',
  model: byok ? 'claude-sonnet-4-5' : 'openwop-free',
  credentialRef: byok ? 'anthropic' : 'managed:openwop-free',
  messages: [{ role: 'user', content: 'Same question.' }, { role: 'assistant', content: 'calling' }, { role: 'user', content: `${TOOL_RESULT} 42` }],
  tools: [{ name: TOOL_NAME, description: 'Look a thing up', inputSchema: { type: 'object' } }],
});

describe.each([
  ['managed', false, () => managedRound],
  ['BYOK', true, () => anthropicRound],
] as const)('ADR 1003 D3 — %s tools round', (label, byok, provider) => {
  it('the chat loop sends the hint on round 2 and not on round 1', async () => {
    const runId = `run-thread-${label}`;
    beginNodeActivity(runId, NODE, 1);
    const out = await runChatToolLoop(
      {
        provider: byok ? 'anthropic' : 'openwop-free',
        model: byok ? 'claude-sonnet-4-5' : 'openwop-free',
        credentialRef: byok ? 'anthropic' : 'managed:openwop-free',
        systemPrompt: 'You answer questions.',
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        tools: [{ def: { name: TOOL_NAME, description: 'read', inputSchema: { type: 'object', properties: {} } }, validate: () => ({ ok: true }) }],
        agentId: 'demo-agent', persona: 'Demo',
      },
      { callAIWithTools: adapterFor(runId, byok).callAIWithTools, executeTool: async () => ({ content: `${TOOL_RESULT} 42` }) },
    );
    expect(out.finalText).toBe('The answer is 42.');
    const calls = provider().mock.calls.map(([r]) => r.cacheConversation === true);
    expect(calls).toEqual([false, true]);
  });

  it('a fork that differs ONLY by the hint is served from the source record (zero live calls)', async () => {
    beginNodeActivity(`run-src-${label}`, NODE, 1);
    await adapterFor(`run-src-${label}`, byok).callAIWithTools(reqFor(byok));
    expect(provider()).toHaveBeenCalledTimes(1);
    provider().mockClear();
    beginNodeActivity(`run-fork-${label}`, NODE, 1);
    await adapterFor(`run-fork-${label}`, byok, `run-src-${label}`).callAIWithTools({ ...reqFor(byok), cacheConversation: true });
    expect(provider()).toHaveBeenCalledTimes(0);
  });

  it('and the reverse: recorded WITH the hint, replayed without it, still served', async () => {
    beginNodeActivity(`run-src2-${label}`, NODE, 1);
    await adapterFor(`run-src2-${label}`, byok).callAIWithTools({ ...reqFor(byok), cacheConversation: true });
    provider().mockClear();
    beginNodeActivity(`run-fork2-${label}`, NODE, 1);
    await adapterFor(`run-fork2-${label}`, byok, `run-src2-${label}`).callAIWithTools(reqFor(byok));
    expect(provider()).toHaveBeenCalledTimes(0);
  });

  it('control: a fork whose MESSAGES differ misses and calls live (the digest is not blind)', async () => {
    beginNodeActivity(`run-src3-${label}`, NODE, 1);
    await adapterFor(`run-src3-${label}`, byok).callAIWithTools(reqFor(byok));
    provider().mockClear();
    beginNodeActivity(`run-fork3-${label}`, NODE, 1);
    await adapterFor(`run-fork3-${label}`, byok, `run-src3-${label}`).callAIWithTools({ ...reqFor(byok), messages: [{ role: 'user', content: 'A different question.' }] });
    expect(provider()).toHaveBeenCalledTimes(1);
  });
});
