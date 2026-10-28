/**
 * Provider tool-name + schema sanitization. Our builtin tool ids
 * (`openwop:ai.research.web`) carry `:` and `.`, which Anthropic/OpenAI/Gemini
 * function-calling APIs reject; Gemini also rejects schema keywords like
 * `additionalProperties`. The dispatchers sanitize for the API call and map the
 * model's chosen name back to the original id so the loop's §A14 check + executor
 * still resolve the tool. (Without this, a chat agent's tool turn fails with
 * "Provider rejected request.")
 *
 * ADR 0101 (Gemini native grounding) + the loop's §A14 reverse-map. What breaks
 * if this goes red: the provider refuses the tool round, or the model's chosen
 * (sanitized) name no longer resolves to the registered tool id. Unique: the
 * dispatch-provider-tools / minimax-tools-round tests use un-namespaced names,
 * so they cannot see sanitization. Request bodies are typed with narrow local
 * interfaces of the provider wire shapes (wave 61: no `any`).
 */
import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest';
import {
  sanitizeToolName,
  toGeminiSchema,
  dispatchGoogleToolsRound,
  dispatchMiniMaxToolsRound,
} from '../src/providers/dispatchProviderTools.js';

/** The Gemini `generateContent` request fields this file reads. */
interface GoogleRequestBody {
  tools: Array<{
    functionDeclarations?: Array<{ name: string; parameters: Record<string, unknown> }>;
    googleSearch?: Record<string, never>;
  }>;
}
/** The OpenAI-compatible (MiniMax) chat-completions request fields this file reads. */
interface OpenAiRequestBody {
  tools: Array<{ type: string; function: { name: string } }>;
}

/** The JSON body of the first `fetch` call, read as the provider wire shape `T`. */
function sentBody<T>(fetchMock: MockInstance<typeof fetch>): T {
  const init = fetchMock.mock.calls[0]?.[1];
  if (typeof init?.body !== 'string') throw new Error('fetch was not called with a string body');
  return JSON.parse(init.body) as T;
}

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
    // Exactly the supported subset: additionalProperties, minLength, minimum and
    // maximum are all dropped, at the root and inside `properties`.
    expect(toGeminiSchema(WEB_TOOL.inputSchema)).toEqual({
      type: 'object',
      properties: { query: { type: 'string' }, maxResults: { type: 'integer' } },
      required: ['query'],
    });
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
    const body = sentBody<GoogleRequestBody>(fetchMock);
    const decl = body.tools[0]?.functionDeclarations?.[0];
    expect(decl?.name).toBe('openwop_ai_research_web');
    expect(decl?.parameters.additionalProperties).toBeUndefined();
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
    const body = sentBody<OpenAiRequestBody>(fetchMock);
    expect(body.tools[0]?.function.name).toBe('openwop_ai_research_web');
  });
});

describe('dispatchGoogleToolsRound — native grounding (ADR 0101)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds the googleSearch grounding tool when webSearch is on (alongside functions)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'grounded answer' }] }, finishReason: 'STOP' }],
    }), { status: 200 }));
    await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash-lite', apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [WEB_TOOL], webSearch: true });
    const body = sentBody<GoogleRequestBody>(fetchMock);
    // functionDeclarations block + a googleSearch block.
    expect(body.tools.some((t) => t.googleSearch !== undefined)).toBe(true);
    expect(body.tools.some((t) => Array.isArray(t.functionDeclarations))).toBe(true);
  });

  it('omits the empty functionDeclarations block for a grounding-only round (no tools)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'grounded' }] } }],
    }), { status: 200 }));
    await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash', apiKey: 'k', messages: [], tools: [], webSearch: true });
    const body = sentBody<GoogleRequestBody>(fetchMock);
    expect(body.tools).toEqual([{ googleSearch: {} }]); // ONLY grounding; no empty functionDeclarations
  });

  it('sends no grounding tool when webSearch is off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
    }), { status: 200 }));
    await dispatchGoogleToolsRound({ model: 'gemini-2.5-flash', apiKey: 'k', messages: [], tools: [WEB_TOOL] });
    const body = sentBody<GoogleRequestBody>(fetchMock);
    expect(body.tools.some((t) => t.googleSearch !== undefined)).toBe(false);
  });
});
