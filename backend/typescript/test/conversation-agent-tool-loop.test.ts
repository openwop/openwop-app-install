/**
 * ADR 0089 Phase 1 — chat-driven agent tool loop.
 *
 * Covers the shared loop core (`runChatToolLoop`) — the one owner of §A14
 * per-call enforcement + RFC 0064 tool-event emission, reused by both the
 * agent-dispatch path and the conversation — and the conversation entry's
 * fallback paths (`runConversationAgentToolTurn` returns null so non-tool
 * agents / unsupported providers take the single completion, never regressing).
 */

import { describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, appendSourcesFooter, type CompiledTool } from '../src/host/agentDispatch.js';
import { runConversationAgentToolTurn, conversationToolTurnEligible } from '../src/host/conversationToolLoop.js';
import type { AiToolCallResult, AiToolCallRequest } from '../src/executor/types.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { RunRecord } from '../src/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

function tool(name: string, ok = true): CompiledTool {
  return {
    def: { name, description: `${name} tool`, inputSchema: { type: 'object' } },
    validate: () => (ok ? { ok: true } : { ok: false, errors: 'bad args' }),
  };
}

const policyStub = (() => undefined) as unknown as ProviderPolicyResolver;

describe('runChatToolLoop (shared observe→act core)', () => {
  it('offers tools, executes a call, feeds the result back, returns the final text', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: 'search', input: { q: 'musk' } }] })
      .mockResolvedValueOnce({ content: 'First principles means reasoning from irreducible facts.', toolCalls: [] });
    const executeTool = vi.fn().mockResolvedValue({ content: 'web results about first principles' });

    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user', content: 'explain' }], tools: [tool('search')], agentId: 'a', persona: 'Researcher' },
      { callAIWithTools, executeTool },
    );

    expect(res.finalText).toBe('First principles means reasoning from irreducible facts.');
    expect(res.error).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith({ name: 'search', input: { q: 'musk' } });
    expect(res.events.some((e) => e.type === 'agent.toolCalled' && e.toolName === 'search')).toBe(true);
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && e.status === 'ok')).toBe(true);
  });

  it('forwards webSearch + appends a deduped Sources footer from grounding citations (ADR 0101 P2)', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: 'Partial.', toolCalls: [{ id: 'c1', name: 'search', input: {} }], citations: [{ url: 'https://a.example', title: 'A' }] })
      .mockResolvedValueOnce({ content: 'Final answer.', toolCalls: [], citations: [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example' }] });
    const executeTool = vi.fn().mockResolvedValue({ content: 'results' });
    const res = await runChatToolLoop(
      { provider: 'google', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user', content: 'go' }], tools: [tool('search')], agentId: 'a', persona: 'P', webSearch: true },
      { callAIWithTools, executeTool },
    );
    expect(res.finalText).toContain('Final answer.');
    expect(res.finalText).toContain('**Sources**');
    expect(res.finalText).toContain('[A](https://a.example)');
    expect(res.finalText).toContain('https://b.example');
    expect(res.finalText.match(/a\.example/g)?.length).toBe(1); // deduped across rounds
    expect(callAIWithTools.mock.calls[0]![0].webSearch).toBe(true); // flag forwarded to the provider
  });

  it('§A14 — refuses a tool NOT on the allowlist (never executes it)', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: 'rm_rf', input: {} }] })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] });
    const executeTool = vi.fn().mockResolvedValue({ content: 'x' });

    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user', content: 'go' }], tools: [tool('search')], agentId: 'a', persona: 'P' },
      { callAIWithTools, executeTool },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && e.status === 'forbidden')).toBe(true);
    expect(res.finalText).toBe('done');
  });

  it('refuses a call whose args fail validation (no execution)', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: 'search', input: { bad: true } }] })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    const executeTool = vi.fn().mockResolvedValue({ content: 'x' });

    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user', content: 'go' }], tools: [tool('search', false)], agentId: 'a', persona: 'P' },
      { callAIWithTools, executeTool },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && e.status === 'invalid_args')).toBe(true);
  });

  it('surfaces a provider error mid-loop without throwing', async () => {
    const callAIWithTools = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'provider_error' }));
    const executeTool = vi.fn();
    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [], tools: [tool('search')], agentId: 'a', persona: 'P' },
      { callAIWithTools, executeTool },
    );
    expect(res.error).toEqual({ code: 'provider_error', message: 'boom' });
  });

  it('streams every event through onEvent', async () => {
    const seen: string[] = [];
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: 'search', input: {} }] })
      .mockResolvedValueOnce({ content: 'fin', toolCalls: [] });
    await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [], tools: [tool('search')], agentId: 'a', persona: 'P', onEvent: (e) => { seen.push(e.type); } },
      { callAIWithTools, executeTool: vi.fn().mockResolvedValue({ content: 'r' }) },
    );
    expect(seen).toContain('agent.toolCalled');
    expect(seen).toContain('agent.toolReturned');
  });
});

describe('conversationToolTurnEligible — when a chat agent runs its tool loop', () => {
  const agent = (allow: string[]): ResolvedAgentManifest =>
    ({ agentId: 'a', persona: 'P', toolAllowlist: allow } as unknown as ResolvedAgentManifest);
  const run = (inputs: Record<string, unknown>): RunRecord =>
    ({ runId: 'r', tenantId: 't', inputs } as unknown as RunRecord);

  it('false for a pure-persona agent (no tools)', () => {
    expect(conversationToolTurnEligible(run({ provider: 'anthropic', credentialRef: 'byok:k' }), agent([]))).toBe(false);
  });
  it('true for the managed (free) tier — MiniMax has a tool-calling round', () => {
    expect(conversationToolTurnEligible(run({ credentialRef: 'managed:openwop-free' }), agent(['search']))).toBe(true);
  });
  it('true for a BYOK tool-calling provider (anthropic / minimax)', () => {
    expect(conversationToolTurnEligible(run({ provider: 'anthropic', credentialRef: 'byok:k' }), agent(['search']))).toBe(true);
    expect(conversationToolTurnEligible(run({ provider: 'minimax', credentialRef: 'byok:k' }), agent(['search']))).toBe(true);
  });
  it('false for a BYOK provider with no tool-calling path', () => {
    expect(conversationToolTurnEligible(run({ provider: 'cohere', credentialRef: 'byok:k' }), agent(['search']))).toBe(false);
  });
});

describe('runConversationAgentToolTurn — falls back (null) without regressing', () => {
  const agent = (allow: string[]): ResolvedAgentManifest =>
    ({ agentId: 'a', persona: 'P', toolAllowlist: allow } as unknown as ResolvedAgentManifest);
  const run = (inputs: Record<string, unknown>): RunRecord =>
    ({ runId: 'r', tenantId: 't', inputs } as unknown as RunRecord);
  const base = { systemPrompt: 'sp', history: [], runId: 'r', nodeId: 'n', conversationId: 'c', policyResolver: policyStub };

  it('returns null for an agent with no tools', async () => {
    expect(await runConversationAgentToolTurn({ ...base, run: run({ provider: 'anthropic', credentialRef: 'byok:k' }), agent: agent([]) })).toBeNull();
  });

  it('returns null for a BYOK provider with no tool-calling path', async () => {
    expect(await runConversationAgentToolTurn({ ...base, run: run({ provider: 'cohere', credentialRef: 'byok:k' }), agent: agent(['search']) })).toBeNull();
  });
});

describe('runChatToolLoop — per-turn budget (Phase 3)', () => {
  it('bounds the loop at maxRounds even if the model never stops calling tools', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValue({ content: 'still working', toolCalls: [{ id: 'c', name: 'search', input: {} }] });
    const executeTool = vi.fn().mockResolvedValue({ content: 'r' });
    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [], tools: [tool('search')], agentId: 'a', persona: 'P', maxRounds: 2 },
      { callAIWithTools, executeTool },
    );
    expect(callAIWithTools).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(res.rounds).toBe(2);
  });
});

describe('appendSourcesFooter (shared by the loop + single-completion reply — review fix)', () => {
  it('appends a markdown Sources list, deduping URLs already linked in the text', () => {
    const out = appendSourcesFooter('An answer citing https://a.example inline.', [
      { url: 'https://a.example', title: 'A' }, // already in text → skipped
      { url: 'https://b.example', title: 'B' },
    ]);
    expect(out).toContain('**Sources**');
    expect(out).toContain('[B](https://b.example)');
    expect(out).not.toContain('[A](https://a.example)'); // deduped against inline link
  });
  it('is a no-op with no citations', () => {
    expect(appendSourcesFooter('plain', [])).toBe('plain');
  });
});
