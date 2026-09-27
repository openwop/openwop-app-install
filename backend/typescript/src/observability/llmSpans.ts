/**
 * ADR 0118 Phase 1 — LLM per-turn / per-dispatch span instrumentation.
 *
 * Wraps the chat-turn → provider-dispatch → tool-call path in OTel spans carrying
 * ONLY allowlist-safe metadata. THE security invariant: prompt/response CONTENT
 * and credentials MUST NEVER appear on a span (ADR 0118 §no-prompt-bytes / SR-1).
 * `safeSpanAttributes` is the single enforcement point — a pure, unit-testable
 * filter — so a caller that accidentally passes a prompt or key sees it dropped.
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

/** The ONLY attribute keys allowed on an LLM span — provider/model/token/latency
 *  metadata. Anything else (prompt, response, messages, credential, apiKey, …) is
 *  dropped. Keep this list TIGHT — adding a content-bearing key is a leak. */
const SAFE_KEYS: ReadonlySet<string> = new Set([
  'provider', 'model', 'inputTokens', 'outputTokens', 'totalTokens',
  'cacheHit', 'latencyMs', 'toolName', 'turnIndex', 'finishReason', 'streamed',
  // ADR 0148 A2 — Anthropic prompt-cache token split (integer counts, no content).
  'cachedReadTokens', 'cacheWriteTokens',
]);

export type LlmSpanAttrs = Record<string, string | number | boolean | undefined>;

/**
 * ADR 0118 Phase 6 — OpenInference span kind (a fixed, closed enum outside the
 * `openwop.*` namespace, so it needs no wire RFC and no allowlist: it provably
 * carries no prompt/PII/credential). Set as the RAW attribute key
 * `openinference.span.kind` so off-the-shelf GenAI trace viewers (Arize Phoenix,
 * Langfuse, Grafana Tempo) can classify the span — do NOT route it through
 * `safeSpanAttributes`, which would (correctly) prefix it `openwop.ai.` and break
 * the convention. Mapping to this app's span tree:
 *   openwop.chat.turn        → 'AGENT'
 *   openwop.provider.dispatch → 'LLM'
 *   tool-call child span      → 'TOOL'
 */
export type OpenInferenceSpanKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN';

/** The raw (non-`openwop.`-prefixed) OpenInference span-kind attribute key. */
export const OPENINFERENCE_SPAN_KIND_KEY = 'openinference.span.kind';

/** Filter attributes to the safe allowlist (prefixing `openwop.ai.`). Drops prompt
 *  content, credentials, and ANY non-allowlisted or undefined key. */
export function safeSpanAttributes(attrs: LlmSpanAttrs): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!SAFE_KEYS.has(k) || v === undefined) continue;
    out[`openwop.ai.${k}`] = v;
  }
  return out;
}

/** Run `fn` inside a child span carrying ONLY allowlist-safe attributes. The span
 *  is closed on success AND error (error recorded, never the prompt). When the
 *  tracer is a no-op (OTel not configured), this is a thin pass-through. */
export async function withLlmSpan<T>(name: string, attrs: LlmSpanAttrs, fn: () => Promise<T>, spanKind?: OpenInferenceSpanKind): Promise<T> {
  const safe = safeSpanAttributes(attrs);
  // The OTel API tracer is a NO-OP when no SDK provider is registered (OTel not
  // configured) — so this is a thin pass-through off the hot path, never throwing.
  return trace.getTracer('openwop.llm-spans').startActiveSpan(name, async (span: Span) => {
    try {
      // ADR 0118 Phase 6 — the OpenInference kind is a fixed closed enum (no
      // content/credential risk), so it's set RAW, alongside (not through) the
      // allowlisted openwop.* attributes.
      if (spanKind) span.setAttribute(OPENINFERENCE_SPAN_KIND_KEY, spanKind);
      for (const [k, v] of Object.entries(safe)) span.setAttribute(k, v);
      const r = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Set additional allowlist-safe attributes on the CURRENTLY-ACTIVE span (e.g.
 *  post-dispatch token counts not known when the span opened). Routes through
 *  `safeSpanAttributes` — the same single enforcement point — so a stray
 *  content/credential key is dropped here too. No-op when no span is active. */
export function annotateActiveLlmSpan(attrs: LlmSpanAttrs): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [k, v] of Object.entries(safeSpanAttributes(attrs))) span.setAttribute(k, v);
}

/** Convenience: the canonical `openwop.provider.dispatch` span name. */
export const PROVIDER_DISPATCH_SPAN = 'openwop.provider.dispatch';
/** Convenience: the canonical `openwop.chat.turn` span name. */
export const CHAT_TURN_SPAN = 'openwop.chat.turn';
