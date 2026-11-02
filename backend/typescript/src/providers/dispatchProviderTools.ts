/**
 * A3 — single-round tool-calling for OpenAI + Google (Gemini), mirroring
 * `dispatchAnthropicToolsRound`'s `ToolsRoundResult` shape so `callAIWithTools`
 * can branch by provider and the agent tool loop is provider-agnostic.
 *
 * Each function performs ONE non-streaming round: send the conversation + the
 * tool declarations, return the model's text + any tool-call requests. The
 * caller (agent loop / pack) orchestrates execution + the next round.
 */

import { toGeminiFunctionDeclaration } from './geminiSchema.js';
import type { ContentPart } from './dispatch.js';
import type { ToolDef, ToolsRoundRequest, ToolsRoundResult } from './dispatchAnthropicTools.js';
import { createLogger } from '../observability/logger.js';
import { ThinkBlockSplitter } from './thinkBlockSplitter.js';

const log = createLogger('providers.tools');

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

/** The Gemini schema projection lives in ONE module (`geminiSchema.ts`) shared by
 *  generateContent tool rounds and both Gemini Live egress paths. Re-exported here
 *  for the existing import sites. */
export { toGeminiSchema } from './geminiSchema.js';

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
/** The visible answer of a completed (non-streamed) round, reasoning removed. */
function stripThinkBlocks(content: string): string {
  if (!content.includes('<think>') && !content.includes('</think>')) return content;
  const splitter = new ThinkBlockSplitter();
  const a = splitter.push(content);
  const b = splitter.flush();
  // An ORPHAN closing tag is not reasoning and not an answer. MiniMax-M3 emits
  // one after a closed block on tool-call rounds; the bare `</think>` then
  // became the round's visible text, was stored as the assistant message, and
  // surfaced as the chat bubble when the turn ended there (measured: 8 visible
  // chars on 6 of 21 rounds, ADR 0773 G-10b, 2026-10-01).
  return (a.visible + b.visible).replace(/<\/think>/g, '').trim();
}

/**
 * Output budget for one tool round when the caller sets none. A reasoning model
 * spends output tokens THINKING before it acts, so 4096 let MiniMax-M3 end a
 * round mid-thought with no tool call and no answer (measured on the managed
 * tier, ADR 0773 G-10b, 2026-09-30). Non-reasoning providers keep 4096.
 */
const REASONING_TOOLS_ROUND_MAX_TOKENS = 16_384;
function defaultToolsRoundMaxTokens(provider: string): number {
  return provider === 'minimax' ? REASONING_TOOLS_ROUND_MAX_TOKENS : 4096;
}

async function openAICompatibleToolsRound(
  req: ToolsRoundRequest,
  endpoint: string,
  errPrefix: string,
): Promise<ToolsRoundResult> {
  const names = toolNameMap(req.tools); // sanitized → original
  const maxTokens = req.maxTokens ?? defaultToolsRoundMaxTokens(errPrefix);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      max_tokens: maxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
      // ADR 1001 — a turn may offer NO tools (a no-tool agent that may still
      // ask a clarification). OpenAI-compatible APIs refuse `tool_choice`
      // without tools, so both are omitted then (the Gemini arm below does the same).
      ...(req.tools.length > 0 ? {
        tools: req.tools.map((t: ToolDef) => ({
          type: 'function',
          function: { name: sanitizeToolName(t.name), description: t.description, parameters: t.inputSchema },
        })),
        tool_choice: 'auto',
      } : {}),
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${errPrefix}_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }>;
    // ADR 0148 A2 (OQ#3) — OpenAI-compatible providers (MiniMax, OpenAI) report
    // AUTOMATIC prefix-cache hits in `prompt_tokens_details.cached_tokens` (no
    // request markers needed; caching fires on ≥512-token stable prefixes). The
    // loop keeps `systemPrompt`+`tools` byte-stable across rounds, so rounds 2..N
    // hit the cache; surface it as `cachedReadTokens` for the same observability
    // the Anthropic split feeds. On the BYOK path this reaches the RFC 0026/0116
    // `provider.usage` event at the emit site (honest, RFC-accepted fields); the
    // MANAGED path never emits provider.usage, so there it stays internal.
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const choice = data.choices?.[0];
  const toolUses = (choice?.message?.tool_calls ?? [])
    .filter((c) => c.type === 'function')
    .map((c) => ({ id: c.id, name: names.get(c.function.name) ?? c.function.name, ...parseToolArgs(c.function.arguments) }));
  // Reasoning models (MiniMax) put their chain-of-thought INLINE as
  // `<think>…</think>`. The plain-chat path splits it off (dispatch.ts runs a
  // ThinkBlockSplitter); this tool round did not, so the whole reasoning reached
  // the visible answer (measured: a 17k-char <think> dump in the builder's Pair
  // chat, ADR 0773 G-10b, 2026-09-30).
  const rawContent = choice?.message?.content ?? '';
  const text = stripThinkBlocks(rawContent);
  // Why a round ended, in COUNTS only (never content). Without this a turn that
  // announces a tool call and then stops is undiagnosable: a model stop, an output
  // budget cut (`length`) and a call the parser never saw all look the same from
  // the chat (measured: ADR 0773 G-10b cases 2 and 4, 2026-10-01).
  log.info('tools_round_outcome', {
    provider: errPrefix,
    finishReason: choice?.finish_reason ?? null,
    maxTokens,
    outputTokens: data.usage?.completion_tokens ?? null,
    structuredToolCalls: toolUses.length,
    rawChars: rawContent.length,
    visibleChars: text.length,
    // Text never becomes a tool call (ADR 1010); this counts how often a model
    // wrote one anyway.
    invokeMarkupInRaw: /<invoke\s+name=|<tool_call>/i.test(rawContent),
  });
  return {
    text,
    toolUses,
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(data.usage?.prompt_tokens != null ? { inputTokens: data.usage.prompt_tokens } : {}),
    ...(data.usage?.completion_tokens != null ? { outputTokens: data.usage.completion_tokens } : {}),
    ...(data.usage?.prompt_tokens_details?.cached_tokens != null ? { cachedReadTokens: data.usage.prompt_tokens_details.cached_tokens } : {}),
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
    status?: string;
    incomplete_details?: { reason?: string } | null;
  };
  // ADR 1011 — Responses reports a cut-off through `status`, not a finish reason.
  // Any incomplete reason other than a safety stop reads as the output limit, so
  // an unknown one still runs nothing.
  const incomplete = data.status === 'incomplete'
    ? (data.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length')
    : undefined;
  const output = data.output ?? [];
  const blocks = output.filter((o) => o.type === 'message').flatMap((m) => m.content ?? []);
  const text = blocks.filter((c) => c.type === 'output_text' && typeof c.text === 'string').map((c) => c.text as string).join('');
  const toolUses = output
    .filter((o) => o.type === 'function_call' && typeof o.name === 'string')
    .map((o) => ({ id: o.call_id ?? `openai-${o.name}`, name: names.get(o.name as string) ?? (o.name as string), ...parseToolArgs(o.arguments ?? '{}') }));
  const citations = blocks
    .flatMap((c) => c.annotations ?? [])
    .filter((a) => a.type === 'url_citation' && typeof a.url === 'string')
    .map((a) => ({ url: a.url as string, ...(a.title ? { title: a.title } : {}) }));
  return {
    text,
    toolUses,
    ...(incomplete ? { finishReason: incomplete } : {}),
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
              functionDeclarations: req.tools.map((t: ToolDef) => toGeminiFunctionDeclaration({
                name: sanitizeToolName(t.name),
                description: t.description,
                parameters: t.inputSchema,
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

/** OpenAI tool-call arguments arrive as a JSON string. Blank or `null` is a call
 *  with no arguments. Anything else that is not a JSON object is marked, never
 *  turned into `{}`: a call the model did not finish must not run (ADR 1011). */
function parseToolArgs(raw: string): { input: Record<string, unknown>; argumentsInvalid?: true } {
  if (raw.trim() === '') return { input: {} };
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null) return { input: {} };
    if (typeof v === 'object' && !Array.isArray(v)) return { input: v as Record<string, unknown> };
  } catch { /* marked below */ }
  return { input: {}, argumentsInvalid: true };
}
