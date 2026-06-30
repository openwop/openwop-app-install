/**
 * Single-round MiniMax tool-calling dispatcher (the managed/free tier's
 * tool-calling primitive). MiniMax is OpenAI-compatible, so one round = one
 * /chat/completions call returning the assistant text + any tool_calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchMiniMaxToolsRound } from '../src/providers/dispatchProviderTools.js';

describe('dispatchMiniMaxToolsRound', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends an OpenAI-shaped tools request and parses tool_calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'searching the web', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"musk"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const r = await dispatchMiniMaxToolsRound({
      model: 'MiniMax-M2.7', apiKey: 'k',
      messages: [{ role: 'user', content: 'explain' }],
      tools: [{ name: 'search', description: 'web search', inputSchema: { type: 'object' } }],
    });

    expect(r.text).toBe('searching the web');
    expect(r.toolUses).toEqual([{ id: 'c1', name: 'search', input: { q: 'musk' } }]);
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(4);

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain('/chat/completions');
    const body = JSON.parse((call[1] as RequestInit).body as string) as { tools: Array<{ function: { name: string } }>; tool_choice: string };
    expect(body.tools[0]!.function.name).toBe('search');
    expect(body.tool_choice).toBe('auto');
  });

  it('returns no tool calls for a plain text completion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'final answer' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    const r = await dispatchMiniMaxToolsRound({ model: 'm', apiKey: 'k', messages: [], tools: [] });
    expect(r.text).toBe('final answer');
    expect(r.toolUses).toEqual([]);
  });

  it('throws a minimax_-prefixed error on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));
    await expect(dispatchMiniMaxToolsRound({ model: 'm', apiKey: 'k', messages: [], tools: [] })).rejects.toThrow(/minimax_429/);
  });
});
