/**
 * A3 — OpenAI + Google single-round tool-calling. Mocks `fetch` to verify the
 * request shape sent to each provider and the parsing of tool-call responses
 * into the shared `ToolsRoundResult`.
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

function mockFetchOnce(jsonBody: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(jsonBody), text: () => Promise.resolve('') } as Response);
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

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(calls[0]!.url).toContain('api.openai.com');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('search');
    expect(res.text).toBe('ok');
    expect(res.toolUses).toEqual([{ id: 'tc1', name: 'search', input: { q: 'x' } }]);
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(3);
  });

  it('throws on non-ok', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('rate') } as Response));
    await expect(dispatchOpenAIToolsRound(baseReq())).rejects.toThrow(/openai_429/);
  });
});

describe('Google (Gemini) tool round (A3)', () => {
  it('maps system→systemInstruction, declares functions, parses functionCall', async () => {
    const { calls } = mockFetchOnce({
      candidates: [{ content: { parts: [{ text: 'sure' }, { functionCall: { name: 'search', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    });

    const res = await dispatchGoogleToolsRound(baseReq());

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    expect(body.systemInstruction.parts[0].text).toBe('be terse');
    expect(body.contents[0].role).toBe('user'); // the non-system user turn
    expect(body.tools[0].functionDeclarations[0].name).toBe('search');
    expect(res.text).toBe('sure');
    expect(res.toolUses).toEqual([{ id: 'gemini-search-0', name: 'search', input: { q: 'x' } }]);
    expect(res.inputTokens).toBe(7);
    expect(res.outputTokens).toBe(2);
  });
});
