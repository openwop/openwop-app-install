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

function contentToText(content: string | readonly ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// ── OpenAI (chat completions, function tools) ──────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export async function dispatchOpenAIToolsRound(req: ToolsRoundRequest): Promise<ToolsRoundResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: req.messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
      tools: req.tools.map((t: ToolDef) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: 'auto',
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openai_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const toolUses = (choice?.message?.tool_calls ?? [])
    .filter((c) => c.type === 'function')
    .map((c) => ({ id: c.id, name: c.function.name, input: safeParseArgs(c.function.arguments) }));
  return {
    text: choice?.message?.content ?? '',
    toolUses,
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(data.usage?.prompt_tokens != null ? { inputTokens: data.usage.prompt_tokens } : {}),
    ...(data.usage?.completion_tokens != null ? { outputTokens: data.usage.completion_tokens } : {}),
  };
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
        {
          functionDeclarations: req.tools.map((t: ToolDef) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
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
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
  // Gemini function calls carry no provider call-id; synthesize a stable one
  // from the name + ordinal so the loop can pair the result.
  let n = 0;
  const toolUses = parts
    .filter((p): p is GeminiPart & { functionCall: { name: string; args?: Record<string, unknown> } } => Boolean(p.functionCall))
    .map((p) => ({ id: `gemini-${p.functionCall.name}-${n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }));
  return {
    text,
    toolUses,
    ...(data.candidates?.[0]?.finishReason ? { finishReason: data.candidates[0].finishReason } : {}),
    ...(data.usageMetadata?.promptTokenCount != null ? { inputTokens: data.usageMetadata.promptTokenCount } : {}),
    ...(data.usageMetadata?.candidatesTokenCount != null ? { outputTokens: data.usageMetadata.candidatesTokenCount } : {}),
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
