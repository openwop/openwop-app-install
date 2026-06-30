/**
 * Provider tool-name + schema sanitization. Our builtin tool ids
 * (`openwop:ai.research.web`) carry `:` and `.`, which Anthropic/OpenAI/Gemini
 * function-calling APIs reject; Gemini also rejects schema keywords like
 * `additionalProperties`. The dispatchers sanitize for the API call and map the
 * model's chosen name back to the original id so the loop's §A14 check + executor
 * still resolve the tool. (Without this, a chat agent's tool turn fails with
 * "Provider rejected request.")
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sanitizeToolName,
  toGeminiSchema,
  dispatchGoogleToolsRound,
  dispatchMiniMaxToolsRound,
} from '../src/providers/dispatchProviderTools.js';

const WEB_TOOL = {
  name: 'openwop:ai.research.web',
  description: 'web research',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 }, maxResults: { type: 'integer', minimum: 1, maximum: 10 } },
    required: ['query'],
    additionalProperties: false,
  },
};

describe('sanitizeToolName', () => {
  it('maps `:` and `.` to `_` (provider name rules)', () => {
    expect(sanitizeToolName('openwop:ai.research.web')).toBe('openwop_ai_research_web');
    expect(sanitizeToolName('openwop:knowledge.search')).toBe('openwop_knowledge_search');
  });
});

describe('toGeminiSchema', () => {
  it('drops keywords Gemini rejects and keeps the supported subset, recursively', () => {
    const out = toGeminiSchema(WEB_TOOL.inputSchema) as Record<string, any>;
    expect(out.additionalProperties).toBeUndefined();
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['query']);
    expect(out.properties.query.type).toBe('string');
    expect(out.properties.query.minLength).toBeUndefined(); // unsupported keyword dropped
    expect(out.properties.maxResults.minimum).toBeUndefined();
  });
});

describe('dispatchGoogleToolsRound — name + schema sanitization + reverse-map', () => {
  afterEach(() => vi.restoreAllMocks());
  it('sends a Gemini-safe name/schema and maps the function call back to the original id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'openwop_ai_research_web', args: { query: 'musk' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
    }), { status: 200 }));

    const r = await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash-lite', apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [WEB_TOOL] });

    // Reverse-mapped to the original id so §A14 + executor resolve it.
    expect(r.toolUses).toEqual([{ id: 'gemini-openwop_ai_research_web-0', name: 'openwop:ai.research.web', input: { query: 'musk' } }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const decl = body.tools[0].functionDeclarations[0];
    expect(decl.name).toBe('openwop_ai_research_web');
    expect(decl.parameters.additionalProperties).toBeUndefined();
  });
});

describe('dispatchMiniMaxToolsRound — OpenAI-compatible name sanitization + reverse-map', () => {
  afterEach(() => vi.restoreAllMocks());
  it('sends a sanitized function name and maps tool_calls back to the original id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'openwop_ai_research_web', arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }],
    }), { status: 200 }));

    const r = await dispatchMiniMaxToolsRound({ model: 'm', apiKey: 'k', messages: [], tools: [WEB_TOOL] });

    expect(r.toolUses).toEqual([{ id: 'c1', name: 'openwop:ai.research.web', input: { query: 'x' } }]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools[0].function.name).toBe('openwop_ai_research_web');
  });
});

describe('dispatchGoogleToolsRound — native grounding (ADR 0101)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds the googleSearch grounding tool when webSearch is on (alongside functions)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'grounded answer' }] }, finishReason: 'STOP' }],
    }), { status: 200 }));
    await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash-lite', apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [WEB_TOOL], webSearch: true });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    // functionDeclarations block + a googleSearch block.
    expect(body.tools.some((t: { googleSearch?: unknown }) => t.googleSearch !== undefined)).toBe(true);
    expect(body.tools.some((t: { functionDeclarations?: unknown }) => Array.isArray(t.functionDeclarations))).toBe(true);
  });

  it('omits the empty functionDeclarations block for a grounding-only round (no tools)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'grounded' }] } }],
    }), { status: 200 }));
    await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash', apiKey: 'k', messages: [], tools: [], webSearch: true });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toEqual([{ googleSearch: {} }]); // ONLY grounding; no empty functionDeclarations
  });

  it('sends no grounding tool when webSearch is off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
    }), { status: 200 }));
    await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash', apiKey: 'k', messages: [], tools: [WEB_TOOL] });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools.some((t: { googleSearch?: unknown }) => t.googleSearch !== undefined)).toBe(false);
  });
});
