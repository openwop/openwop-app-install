/**
 * ADR 0089 Phase 1 — chat-driven agent tool loop.
 *
 * Covers the shared loop core (`runChatToolLoop`) — the one owner of §A14
 * per-call enforcement + RFC 0064 tool-event emission, reused by both the
 * agent-dispatch path and the conversation — and the conversation entry's
 * fallback paths (`runConversationAgentToolTurn` returns null so non-tool
 * agents / unsupported providers take the single completion, never regressing).
 *
 * Sabotage-witnessed (w77): running an unlisted tool reds the §A14 case; skipping
 * argument validation reds the validation case; dropping the tool result from the
 * next round, or offering no tools, reds the first case; clearing citations per
 * round reds the Sources case; replacing a thrown code with the fallback reds the
 * provider-error case; one extra round reds the budget case; withholding one event
 * type from `onEvent` reds the streaming case; restoring the empty-manifest
 * bail-out reds both ADR 0315 cases. `appendSourcesFooter` has two `return text`
 * guards, so its no-op case is witnessed by one edit that removes both.
 */

import { describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, appendSourcesFooter, type CompiledTool } from '../src/host/agentDispatch.js';
import { runConversationAgentToolTurn, conversationToolTurnEligible } from '../src/host/conversationToolLoop.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
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

const policyStub: ProviderPolicyResolver = { resolveForRun: async () => [] };

const agent = (allow: string[]): ResolvedAgentManifest => ({
  agentId: 'a', persona: 'P', modelClass: 'chat', systemPrompt: 'sp', toolAllowlist: allow, packName: 'test.pack', packVersion: '1.0.0',
});
const run = (inputs: Record<string, unknown>): RunRecord => ({
  runId: 'r', workflowId: 'w', tenantId: 't', status: 'running', inputs, metadata: {}, configurable: {},
  createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z',
});

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
    expect(executeTool).toHaveBeenCalledWith({ name: 'search', input: { q: 'musk' }, callId: 'c1' });
    // Offered: the model saw exactly the permitted tool.
    expect(callAIWithTools.mock.calls[0]![0].tools.map((t) => t.name)).toEqual(['search']);
    // Fed back: the next round carries the tool's result.
    expect(callAIWithTools).toHaveBeenCalledTimes(2);
    expect(callAIWithTools.mock.calls[1]![0].messages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringMatching(/^Result of search: [\s\S]*web results about first principles/),
    });
    expect(res.events.find((e) => e.type === 'agent.toolCalled')).toMatchObject({ toolName: 'search', callId: 'c1' });
    expect(res.events.find((e) => e.type === 'agent.toolReturned')).toMatchObject({ toolName: 'search', callId: 'c1', status: 'ok' });
  });

  it('forwards webSearch + appends a deduped Sources footer from grounding citations (ADR 0101 P2)', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: 'Partial.', toolCalls: [{ id: 'c1', name: 'search', input: {} }], citations: [{ url: 'https://a.example', title: 'A' }, { url: 'https://c.example', title: 'C' }] })
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
    expect(res.finalText).toContain('[C](https://c.example)'); // cited only in the first round
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
    expect(res.events.find((e) => e.type === 'agent.toolReturned')).toMatchObject({ toolName: 'rm_rf', status: 'forbidden' });
    expect(callAIWithTools.mock.calls[1]![0].messages.at(-1)?.content).toBe('Tool "rm_rf" is not permitted for this agent.');
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
    // RFC 0064 §E — validation failure surfaces as `status:'error'` + `error.code:'invalid_args'`.
    expect(res.events.find((e) => e.type === 'agent.toolReturned')).toMatchObject({ status: 'error', error: { code: 'invalid_args' } });
  });

  it('surfaces a provider error mid-loop without throwing', async () => {
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: 'Working on it.', toolCalls: [{ id: 'c1', name: 'search', input: {} }] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'upstream_timeout' }));
    const executeTool = vi.fn().mockResolvedValue({ content: 'r' });
    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [], tools: [tool('search')], agentId: 'a', persona: 'P' },
      { callAIWithTools, executeTool },
    );
    expect(res.error).toEqual({ code: 'upstream_timeout', message: 'boom' });
    expect(res.rounds).toBe(2);
    expect(res.finalText).toBe('Working on it.');
  });

  it('streams every event through onEvent', async () => {
    const seen: string[] = [];
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: 'search', input: {} }] })
      .mockResolvedValueOnce({ content: 'fin', toolCalls: [] });
    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [], tools: [tool('search')], agentId: 'a', persona: 'P', onEvent: (e) => { seen.push(e.type); } },
      { callAIWithTools, executeTool: vi.fn().mockResolvedValue({ content: 'r' }) },
    );
    expect(seen).toEqual(res.events.map((e) => e.type));
    expect(seen).toEqual(expect.arrayContaining(['agent.reasoned', 'agent.toolCalled', 'agent.toolReturned']));
  });
});

describe('conversationToolTurnEligible — when a chat agent runs its tool loop', () => {
  it('TRUE even for an empty-manifest agent — the ADR 0315 default-on baseline means no agent is pure-persona', () => {
    expect(conversationToolTurnEligible(run({ provider: 'anthropic', credentialRef: 'byok:k' }), agent([]))).toBe(true);
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
  const base = { systemPrompt: 'sp', history: [], runId: 'r', nodeId: 'n', conversationId: 'c', policyResolver: policyStub };

  it('an empty-manifest agent ENTERS the tool path (ADR 0315 baseline) — no null short-circuit', async () => {
    // Pre-ADR-0315 this returned null before touching any store; now the loop
    // proceeds (and in this storeless harness the first durable read throws),
    // proving the "pure persona ⇒ single completion" bail-out is gone.
    initHostExtPersistence(await openStorage('memory://'));
    try {
      // With persistence available the path runs past eligibility, compiles the
      // BASELINE tools, and reaches BYOK key resolution — unconfigured in this
      // harness, so it throws there. Pre-0315 it resolved null before ever
      // touching key material; getting this deep is the behavior under test.
      await expect(
        runConversationAgentToolTurn({ ...base, run: run({ provider: 'anthropic', credentialRef: 'byok:k' }), agent: agent([]) }),
      ).rejects.toThrow(/secretResolver/);
    } finally {
      __resetHostExtPersistence();
    }
  });

  it('returns null for a BYOK provider with no tool-calling path', async () => {
    expect(await runConversationAgentToolTurn({ ...base, run: run({ provider: 'cohere', credentialRef: 'byok:k' }), agent: agent(['search']) })).toBeNull();
  });
});

describe('runChatToolLoop — per-turn budget (Phase 3)', () => {
  it('bounds the loop at maxRounds even if the model never stops calling tools', async () => {
    // Distinct arguments each round: an IDENTICAL repeat is answered without
    // re-running (ADR 0975 D6, pinned in adr0975-tool-loop-repeat-guard).
    let round = 0;
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockImplementation(async () => ({ content: 'still working', toolCalls: [{ id: `c${round}`, name: 'search', input: { page: round++ } }] }));
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
