/**
 * ADR 0148 A2 (OQ#3) — MiniMax / OpenAI-compatible AUTOMATIC prefix caching.
 *
 * MiniMax caches identical request prefixes automatically (no `cache_control`
 * markers; fires on ≥512-token prefixes ordered tools → system → messages) and
 * reports hits in `usage.prompt_tokens_details.cached_tokens`. Two invariants
 * make the free-tier tool loop actually hit that cache — and this file pins both:
 *
 *  1. we PARSE `cached_tokens` into `cachedReadTokens` (so the win is
 *     observable, and so a future accounting change can see it), and
 *  2. the tool loop keeps the cacheable prefix (system prompt + tool surface)
 *     BYTE-STABLE across rounds — the property MiniMax's prefix cache depends
 *     on. A refactor that reordered tools or mutated the system prompt per round
 *     would silently kill the caching; this test fails loudly if that happens.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { dispatchMiniMaxToolsRound } from '../src/providers/dispatchProviderTools.js';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const tool = (name: string): CompiledTool => ({
  def: { name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } },
  validate: () => ({ ok: true }),
});

describe('OpenAI-compatible tools round — parses the automatic prefix-cache split', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces prompt_tokens_details.cached_tokens as cachedReadTokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'done', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 900 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await dispatchMiniMaxToolsRound({
      model: 'MiniMax-M3', apiKey: 'k',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ name: 'openwop:kanban.add-todo', description: 'add a todo', inputSchema: { type: 'object' } }],
    });

    expect(res.inputTokens).toBe(1200);
    expect(res.cachedReadTokens).toBe(900); // 75% of the prompt served from cache
  });

  it('serializes the tools+system prefix DETERMINISTICALLY across identical calls (the real cache-key bytes)', async () => {
    // The loop passing the same references is necessary but not sufficient — MiniMax
    // keys its automatic cache on the SERIALIZED request prefix. This exercises the
    // actual `openAICompatibleToolsRound` body build (tool order, #578 name
    // sanitization, parameter schema) that a prefix-instability regression would live in.
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit).body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 600, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const req = {
      model: 'MiniMax-M3', apiKey: 'k',
      messages: [{ role: 'system' as const, content: 'STABLE PREFIX' }, { role: 'user' as const, content: 'go' }],
      tools: [
        { name: 'openwop:kanban.add-todo', description: 'add', inputSchema: { type: 'object' as const } },
        { name: 'openwop:ai.research.web', description: 'search', inputSchema: { type: 'object' as const } },
      ],
    };
    await dispatchMiniMaxToolsRound(req);
    await dispatchMiniMaxToolsRound(req);
    expect(bodies).toHaveLength(2);
    const a = JSON.parse(bodies[0]!) as { tools: Array<{ function: { name: string } }>; messages: unknown };
    const b = JSON.parse(bodies[1]!) as { tools: Array<{ function: { name: string } }>; messages: unknown };
    // Byte-identical tools block + system message = a warm cache on the 2nd call.
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
    // Order preserved and names #578-sanitized (no ':'/'.') — the wire form the cache keys on.
    expect(a.tools.map((t) => t.function.name)).toEqual(['openwop_kanban_add-todo', 'openwop_ai_research_web']);
  });

  it('omits cachedReadTokens when the provider reports no cache detail (first round / <512 tok)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'done', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await dispatchMiniMaxToolsRound({
      model: 'MiniMax-M3', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'openwop:ai.research.web', description: 'search', inputSchema: { type: 'object' } }],
    });
    expect(res.cachedReadTokens).toBeUndefined();
  });
});

describe('tool loop — the cacheable prefix stays byte-stable across rounds', () => {
  it('sends an identical systemPrompt + tool surface each round, appending only new messages', async () => {
    const seen: AiToolCallRequest[] = [];
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockImplementationOnce(async (req) => { seen.push(req); return { content: '', toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }] }; })
      .mockImplementationOnce(async (req) => { seen.push(req); return { content: 'final', toolCalls: [] }; });
    const executeTool = vi.fn().mockResolvedValue({ content: 'result bytes' });

    await runChatToolLoop(
      { provider: 'minimax', model: 'MiniMax-M3', credentialRef: 'managed:openwop-free', systemPrompt: 'STABLE SYSTEM PREFIX', messages: [{ role: 'user', content: 'go' }], tools: [tool('search')], agentId: 'a', persona: 'P' },
      { callAIWithTools, executeTool },
    );

    expect(seen).toHaveLength(2);
    // The cacheable prefix (system + tool surface) is byte-identical round to round.
    expect(seen[1]!.systemPrompt).toBe(seen[0]!.systemPrompt);
    expect(JSON.stringify(seen[1]!.tools)).toBe(JSON.stringify(seen[0]!.tools));
    // Messages only GROW at the end — round 2's list starts with round 1's exact
    // sequence, so the cached prefix extends rather than shifting.
    const first = seen[0]!.messages;
    const second = seen[1]!.messages;
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.slice(0, first.length)).toEqual(first);
  });
});
