/**
 * A3 — single-round tool-calling for OpenAI + Google (Gemini), mirroring
 * `dispatchAnthropicToolsRound`'s `ToolsRoundResult` shape so `callAIWithTools`
 * can branch by provider and the agent tool loop is provider-agnostic.
 *
 * Each function performs ONE non-streaming round: send the conversation + the
 * tool declarations, return the model's text + any tool-call requests. The
 * caller (agent loop / pack) orchestrates execution + the next round.
 */

import type { ContentPart } from './dispatch.js';
import type { ToolDef, ToolsRoundRequest, ToolsRoundResult } from './dispatchAnthropicTools.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('providers.tools');

/** MiniMax-M models sometimes emit a tool call as inline TEXT — an Anthropic-style
 *  `<invoke name="…"><parameter name="…">value</parameter></invoke>` block, often wrapped
 *  in model delimiter tokens (e.g. `<minimax>` markers that surface as `]<]minimax[>[`) —
 *  instead of the structured `tool_calls` field. Parse those so they EXECUTE (HITL + run)
 *  rather than leaking raw markup into the chat. Returns the parsed tool calls + the visible
 *  text with the markup stripped. The emitted name is resolved leniently to a real tool id
 *  (the model often drops the `openwop:` prefix / restores `.`). */
export function parseInlineToolCalls(
  raw: string,
  tools: readonly ToolDef[],
): { toolUses: ToolsRoundResult['toolUses']; cleanedText: string } {
  // Strip model delimiter noise WITHOUT eating the real `<invoke>`/`<parameter>` tags:
  // the observed leak token (`]<]minimax[>[`) + `<minimax …>` / `</minimax>` variants.
  const denoised = raw
    .replace(/\]<\]minimax\[>\[/g, '')
    .replace(/<\/?minimax\b[^>]*>/gi, '');
  const resolve = (emitted: string): string => {
    const e = emitted.trim();
    const exact = tools.find((t) => t.name === e);
    if (exact) return exact.name;
    const fuzzy = tools.find((t) => t.name.endsWith(e) || sanitizeToolName(t.name) === sanitizeToolName(e));
    return fuzzy ? fuzzy.name : e;
  };
  const toolUses: ToolsRoundResult['toolUses'] = [];
  const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi;
  let im: RegExpExecArray | null;
  let i = 0;
  while ((im = invokeRe.exec(denoised)) !== null) {
    const name = resolve(im[1]);
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(im[2])) !== null) args[pm[1].trim()] = pm[2].trim();
    toolUses.push({ id: `minimax_inline_${i++}`, name, input: args });
  }
  const cleanedText = denoised
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(invokeRe, '')
    .trim();
  return { toolUses, cleanedText };
}

function contentToText(content: string | readonly ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Provider function-calling APIs require tool names to match ~`[a-zA-Z0-9_-]`
 *  (Anthropic/OpenAI reject `:` and `.`; Gemini rejects `:`). Our builtin tool
 *  ids are `openwop:ai.research.web`, so map disallowed chars to `_` for the API
 *  call. Callers reverse-map the model's chosen name via `toolNameMap` so the
 *  loop's §A14 check + executor still see the original id. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Build a {sanitized → original} map so a provider's tool-call name resolves
 *  back to the original tool id. */
export function toolNameMap(tools: readonly ToolDef[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tools) m.set(sanitizeToolName(t.name), t.name);
  return m;
}

/** Keywords Gemini's FunctionDeclaration parameter schema accepts (an OpenAPI
 *  subset). Everything else (`additionalProperties`, `minLength`, `minimum`,
 *  `$schema`, …) is dropped — Gemini rejects the whole request otherwise. */
const GEMINI_SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minItems', 'maxItems']);

/** Recursively project a JSON Schema onto Gemini's accepted subset. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue; // drop additionalProperties / minLength / $schema / …
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items') {
      out.items = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── OpenAI (chat completions, function tools) ──────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** MiniMax's OpenAI-compatible Chat Completions base URL (overridable for tests
 *  / self-host). MiniMax speaks the same `/chat/completions` + `tool_calls`
 *  shape as OpenAI, so one round implementation serves both. */
const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

/** One tool-calling round against an OpenAI-compatible Chat Completions endpoint
 *  (OpenAI, MiniMax). The observe→act loop lives in the caller (`runChatToolLoop`);
 *  this is a SINGLE request that returns the assistant text + any tool calls. */
async function openAICompatibleToolsRound(
  req: ToolsRoundRequest,
  endpoint: string,
  errPrefix: string,
): Promise<ToolsRoundResult> {
  const names = toolNameMap(req.tools); // sanitized → original
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: req.messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
      tools: req.tools.map((t: ToolDef) => ({
        type: 'function',
        function: { name: sanitizeToolName(t.name), description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: 'auto',
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${errPrefix}_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  let toolUses = (choice?.message?.tool_calls ?? [])
    .filter((c) => c.type === 'function')
    .map((c) => ({ id: c.id, name: names.get(c.function.name) ?? c.function.name, input: safeParseArgs(c.function.arguments) }));
  let text = choice?.message?.content ?? '';
  // MiniMax-M sometimes returns the tool call as inline TEXT instead of structured
  // `tool_calls` (it leaks `<invoke …>` markup into the bubble + nothing executes). When
  // we see that shape with no structured calls, parse + strip it so it runs like normal.
  if (toolUses.length === 0 && /<invoke\s+name=|<tool_call>/i.test(text)) {
    // Diagnostic: capture the EXACT raw shape so the parser can be tuned to it.
    log.warn('inline_tool_call_detected', {
      provider: errPrefix,
      sentToolNames: [...names.keys()],
      rawContent: text.slice(0, 2000),
    });
    const parsed = parseInlineToolCalls(text, req.tools);
    if (parsed.toolUses.length > 0) {
      toolUses = parsed.toolUses;
      text = parsed.cleanedText;
      log.info('inline_tool_call_parsed', { provider: errPrefix, count: toolUses.length, names: toolUses.map((t) => t.name) });
    }
  }
  return {
    text,
    toolUses,
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(data.usage?.prompt_tokens != null ? { inputTokens: data.usage.prompt_tokens } : {}),
    ...(data.usage?.completion_tokens != null ? { outputTokens: data.usage.completion_tokens } : {}),
  };
}

export function dispatchOpenAIToolsRound(req: ToolsRoundRequest): Promise<ToolsRoundResult> {
  // Native web search lives on the Responses API (the built-in `web_search`
  // tool); plain tool turns stay on Chat Completions so non-search OpenAI turns
  // are unaffected (ADR 0101 — the fork is isolated to webSearch).
  if (req.webSearch) return openAIResponsesToolsRound(req);
  return openAICompatibleToolsRound(req, 'https://api.openai.com/v1/chat/completions', 'openai');
}

/** One OpenAI **Responses API** round with the built-in `web_search` tool +
 *  custom function tools (ADR 0101). The Responses API flattens function tools
 *  (`{type:'function', name, parameters}`), uses `input` for messages, and
 *  returns an `output[]` of `function_call` / `web_search_call` / `message`
 *  items (the message carries `output_text` + `url_citation` annotations).
 *  NOTE: not yet live-verified against the GPT-5.x catalog models — the model
 *  `webSearch` flag stays off until that check (capability honesty). */
async function openAIResponsesToolsRound(req: ToolsRoundRequest): Promise<ToolsRoundResult> {
  const names = toolNameMap(req.tools); // sanitized → original
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      input: req.messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
      tools: [
        ...req.tools.map((t: ToolDef) => ({ type: 'function', name: sanitizeToolName(t.name), description: t.description, parameters: t.inputSchema })),
        { type: 'web_search' },
      ],
      max_output_tokens: req.maxTokens ?? 4096,
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openai_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    output?: Array<{
      type: string;
      call_id?: string; name?: string; arguments?: string;
      content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; url?: string; title?: string }> }>;
    }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const output = data.output ?? [];
  const blocks = output.filter((o) => o.type === 'message').flatMap((m) => m.content ?? []);
  const text = blocks.filter((c) => c.type === 'output_text' && typeof c.text === 'string').map((c) => c.text as string).join('');
  const toolUses = output
    .filter((o) => o.type === 'function_call' && typeof o.name === 'string')
    .map((o) => ({ id: o.call_id ?? `openai-${o.name}`, name: names.get(o.name as string) ?? (o.name as string), input: safeParseArgs(o.arguments ?? '{}') }));
  const citations = blocks
    .flatMap((c) => c.annotations ?? [])
    .filter((a) => a.type === 'url_citation' && typeof a.url === 'string')
    .map((a) => ({ url: a.url as string, ...(a.title ? { title: a.title } : {}) }));
  return {
    text,
    toolUses,
    ...(data.usage?.input_tokens != null ? { inputTokens: data.usage.input_tokens } : {}),
    ...(data.usage?.output_tokens != null ? { outputTokens: data.usage.output_tokens } : {}),
    ...(citations.length > 0 ? { citations } : {}),
  };
}

/** A single MiniMax tool-calling round — backs the managed (free) tier + a BYOK
 *  MiniMax key. MiniMax is OpenAI-compatible, so it reuses the shared round. */
export function dispatchMiniMaxToolsRound(req: ToolsRoundRequest): Promise<ToolsRoundResult> {
  const baseUrl = (process.env.MINIMAX_API_BASE_URL ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/$/, '');
  return openAICompatibleToolsRound(req, `${baseUrl}/chat/completions`, 'minimax');
}

// ── Google (Gemini generateContent, functionDeclarations) ──────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

export async function dispatchGoogleToolsRound(req: ToolsRoundRequest): Promise<ToolsRoundResult> {
  // Gemini takes the system turn as a separate `systemInstruction`; user/assistant
  // map to user/model `contents`.
  const system = req.messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).join('\n');
  const contents = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: contentToText(m.content) }] }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': req.apiKey },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      tools: [
        // Omit an empty functionDeclarations block (Gemini rejects it) — e.g. a
        // grounding-only round with no host tools.
        ...(req.tools.length > 0
          ? [{
              functionDeclarations: req.tools.map((t: ToolDef) => ({
                name: sanitizeToolName(t.name),
                description: t.description,
                parameters: toGeminiSchema(t.inputSchema),
              })),
            }]
          : []),
        // Native Google Search grounding — uses the SAME Gemini key (ADR 0101),
        // no separate search-vendor key. Gemini 2.x permits combining grounding
        // with functionDeclarations; the grounded answer returns as text.
        ...(req.webSearch ? [{ googleSearch: {} }] : []),
      ],
      generationConfig: { maxOutputTokens: req.maxTokens ?? 4096 },
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`google_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
      // Native Google Search grounding sources (ADR 0101 Phase 2).
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
  // Gemini function calls carry no provider call-id; synthesize a stable one
  // from the name + ordinal so the loop can pair the result.
  let n = 0;
  const names = toolNameMap(req.tools); // sanitized → original
  const toolUses = parts
    .filter((p): p is GeminiPart & { functionCall: { name: string; args?: Record<string, unknown> } } => Boolean(p.functionCall))
    .map((p) => ({ id: `gemini-${p.functionCall.name}-${n++}`, name: names.get(p.functionCall.name) ?? p.functionCall.name, input: p.functionCall.args ?? {} }));
  const citations = (data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .filter((c): c is { web: { uri: string; title?: string } } => typeof c.web?.uri === 'string')
    .map((c) => ({ url: c.web.uri, ...(c.web.title ? { title: c.web.title } : {}) }));
  return {
    text,
    toolUses,
    ...(data.candidates?.[0]?.finishReason ? { finishReason: data.candidates[0].finishReason } : {}),
    ...(data.usageMetadata?.promptTokenCount != null ? { inputTokens: data.usageMetadata.promptTokenCount } : {}),
    ...(data.usageMetadata?.candidatesTokenCount != null ? { outputTokens: data.usageMetadata.candidatesTokenCount } : {}),
    ...(citations.length > 0 ? { citations } : {}),
  };
}

/** OpenAI tool-call arguments arrive as a JSON string; tolerate malformed. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
