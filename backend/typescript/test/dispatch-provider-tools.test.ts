/**
 * OpenAI + Google single-round tool-calling (TST-CWA-4; the ADR 0101 tool-round
 * fork, ADR 1001 no-tool turns). Mocks `fetch` with real `Response`s to verify
 * the request each provider receives and the parsing of tool-call responses into
 * the shared `ToolsRoundResult`.
 *
 * Red when (sabotage-witnessed, wave 69): tool-call arguments are not parsed, or
 * the tool type is not `function` ("sends function tools"); the non-ok error
 * drops `openai_<status>` ("throws on non-ok"); Gemini loses `systemInstruction`,
 * keeps the system turn inside `contents`, or drops `usageMetadata` token counts
 * ("maps system→systemInstruction").
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchOpenAIToolsRound, dispatchGoogleToolsRound } from '../src/providers/dispatchProviderTools.js';
import type { ToolsRoundRequest } from '../src/providers/dispatchAnthropicTools.js';

const TOOL: ToolsRoundRequest['tools'][number] = {
  name: 'search',
  description: 'Search',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

function baseReq(overrides: Partial<ToolsRoundRequest> = {}): ToolsRoundRequest {
  return {
    model: 'm',
    apiKey: 'k',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'find x' },
    ],
    tools: [TOOL],
    ...overrides,
  };
}

interface Call { url: string; init: RequestInit }

function mockFetchOnce(jsonBody: unknown, status = 200): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody), { status, headers: { 'content-type': 'application/json' } });
  });
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI tool round (A3)', () => {
  it('sends function tools and parses tool_calls', async () => {
    const { calls } = mockFetchOnce({
      choices: [{ message: { content: 'ok', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    });

    const res = await dispatchOpenAIToolsRound(baseReq());

    const body = JSON.parse(calls[0]!.init.body as string) as { tools: Array<{ type: string; function: { name: string } }> };
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe('https://api.openai.com');
    expect(url.pathname).toMatch(/^\/v\d+\/chat\/completions$/);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.type).toBe('function');
    expect(body.tools[0]!.function.name).toBe('search');
    expect(res.text).toBe('ok');
    expect(res.toolUses).toEqual([{ id: 'tc1', name: 'search', input: { q: 'x' } }]);
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(3);
  });

  it('throws on non-ok', async () => {
    mockFetchOnce('rate', 429);
    await expect(dispatchOpenAIToolsRound(baseReq())).rejects.toThrow('openai_429: rate');
  });
});

describe('Google (Gemini) tool round (A3)', () => {
  it('maps system→systemInstruction, declares functions, parses functionCall', async () => {
    const { calls } = mockFetchOnce({
      candidates: [{ content: { parts: [{ text: 'sure' }, { functionCall: { name: 'search', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    });

    const res = await dispatchGoogleToolsRound(baseReq());

    const body = JSON.parse(calls[0]!.init.body as string) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: unknown[];
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    // The system turn lives ONLY in systemInstruction — never also as a `user` content.
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'find x' }] }]);
    expect(body.tools[0]!.functionDeclarations[0]!.name).toBe('search');
    expect(res.text).toBe('sure');
    expect(res.toolUses).toEqual([{ id: 'gemini-search-0', name: 'search', input: { q: 'x' } }]);
    expect(res.inputTokens).toBe(7);
    expect(res.outputTokens).toBe(2);
  });
});
