/**
 * ADR 0101 Phase 2 — native web search + citation capture in the tool-round
 * dispatchers. Gemini grounding (`groundingMetadata`) and the Anthropic
 * `web_search_20250305` server tool both ride the EXISTING dispatch call; their
 * sources are normalized into `ToolsRoundResult.citations` (the same `Citation`
 * shape the single-completion grounding path emits).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchGoogleToolsRound, dispatchOpenAIToolsRound } from '../src/providers/dispatchProviderTools.js';
import { dispatchAnthropicToolsRound } from '../src/providers/dispatchAnthropicTools.js';

const TOOL = { name: 'openwop:ai.research.web', description: 'web', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };

describe('dispatchGoogleToolsRound — grounding citations', () => {
  afterEach(() => vi.restoreAllMocks());
  it('captures groundingMetadata.groundingChunks as citations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'grounded answer' }] },
        finishReason: 'STOP',
        groundingMetadata: { groundingChunks: [
          { web: { uri: 'https://a.example/1', title: 'Source A' } },
          { web: { uri: 'https://b.example/2' } },
          { web: {} }, // no uri — dropped
        ] },
      }],
    }), { status: 200 }));
    const r = await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash', apiKey: 'k', messages: [], tools: [], webSearch: true });
    expect(r.text).toBe('grounded answer');
    expect(r.citations).toEqual([
      { url: 'https://a.example/1', title: 'Source A' },
      { url: 'https://b.example/2' },
    ]);
  });
  it('no citations field when the response has no grounding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'plain' }] } }],
    }), { status: 200 }));
    const r = await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash', apiKey: 'k', messages: [], tools: [TOOL] });
    expect(r.citations).toBeUndefined();
  });
});

describe('dispatchAnthropicToolsRound — native web_search server tool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds the web_search_20250305 tool when webSearch is on', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    }), { status: 200 }));
    await dispatchAnthropicToolsRound({ model: 'claude-x', apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [TOOL], webSearch: true });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools.some((t: { type?: string }) => t.type === 'web_search_20250305')).toBe(true);
    // the custom agent tool is still present alongside it
    expect(body.tools.some((t: { name?: string }) => t.name === 'openwop_ai_research_web')).toBe(true);
  });

  it('parses web_search_tool_result blocks into citations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [
          { type: 'web_search_result', url: 'https://x.example', title: 'X' },
          { type: 'web_search_result', url: 'https://y.example' },
        ] },
        { type: 'text', text: 'the answer' },
      ],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    const r = await dispatchAnthropicToolsRound({ model: 'claude-x', apiKey: 'k', messages: [], tools: [], webSearch: true });
    expect(r.text).toBe('the answer');
    expect(r.citations).toEqual([{ url: 'https://x.example', title: 'X' }, { url: 'https://y.example' }]);
    // server_tool_use is NOT surfaced as an agent tool call
    expect(r.toolUses).toEqual([]);
  });

  it('sends no web_search tool when webSearch is off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'x' }],
    }), { status: 200 }));
    await dispatchAnthropicToolsRound({ model: 'claude-x', apiKey: 'k', messages: [], tools: [TOOL] });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools.some((t: { type?: string }) => t.type === 'web_search_20250305')).toBe(false);
  });
});

describe('dispatchOpenAIToolsRound — Responses API web search (ADR 0101 deferral)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes to the Responses API with web_search + function tools, parses output + url_citations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [
        { type: 'web_search_call', id: 'ws1' },
        { type: 'function_call', call_id: 'fc1', name: 'openwop_ai_research_web', arguments: '{"query":"x"}' },
        { type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: 'grounded answer', annotations: [
            { type: 'url_citation', url: 'https://o.example', title: 'O' },
          ] },
        ] },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
    }), { status: 200 }));

    const r = await dispatchOpenAIToolsRound({ model: 'gpt-5.4', apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [TOOL], webSearch: true });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/responses');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools.some((t: { type?: string }) => t.type === 'web_search')).toBe(true);
    expect(body.tools.some((t: { type?: string; name?: string }) => t.type === 'function' && t.name === 'openwop_ai_research_web')).toBe(true);
    expect(r.text).toBe('grounded answer');
    expect(r.toolUses).toEqual([{ id: 'fc1', name: 'openwop:ai.research.web', input: { query: 'x' } }]);
    expect(r.citations).toEqual([{ url: 'https://o.example', title: 'O' }]);
  });

  it('stays on Chat Completions when webSearch is off (no regression)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'plain', tool_calls: [] }, finish_reason: 'stop' }],
    }), { status: 200 }));
    await dispatchOpenAIToolsRound({ model: 'gpt-5.4', apiKey: 'k', messages: [], tools: [TOOL] });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/chat/completions');
  });
});
