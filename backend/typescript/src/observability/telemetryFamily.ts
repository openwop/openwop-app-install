/**
 * RFC 0262 — the v2 `telemetry` family (ADR 1146). Presence is the claim that
 * this host exports OTLP traces as `spec/v2/core/telemetry.md` requires: an
 * `openwop.run` span per run, an `openwop.node.<typeId>` span per node execution
 * (both already emitted by the executor), an inbound `traceparent` continued, and
 * no credential material in any span (the `safeSpanAttributes` allowlist).
 *
 * Advertised only while BOTH hold:
 *   - `OPENWOP_TELEMETRY_FAMILY` is `true` or `1`, a default-off switch; and
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so `tracer.ts` actually wired an
 *     exporter. An advert with no exporter would claim an export that never
 *     happens.
 * The same predicate turns on the one behaviour the claim adds,
 * `traceparent` continuation on the run span (`runSpanParent`), so the
 * advertisement and the behaviour cannot drift apart.
 *
 * The exporter is `@opentelemetry/exporter-trace-otlp-http`, which sends
 * OTLP/HTTP JSON, hence `protocols: ["http/json"]`.
 *
 * ADR 1146 D5 — `genAiSemconv`. Under the same predicate, each model-call span
 * (`wrapInSpan`, aiProvidersHost.ts) carries the OTel GenAI semantic conventions
 * 1.37.0 chat-call set: `gen_ai.operation.name`, `gen_ai.provider.name`,
 * `gen_ai.request.model` and the two usage-token counts. Never prompt or
 * completion text, never a system prompt: only operation, provider, model and
 * token counts (`genAiSpanAttributes` is the one place they are built).
 */
import { ROOT_CONTEXT, propagation, type Context } from '@opentelemetry/api';
import { runTraceContext, traceHeaders } from '../host/traceContext.js';
import { toWireRunId } from '../host/v2Ids.js';

export const TELEMETRY_FAMILY_FLAG = 'OPENWOP_TELEMETRY_FAMILY';
export const OTLP_PROTOCOLS = ['http/json'] as const;

export function telemetryFamilyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[TELEMETRY_FAMILY_FLAG] ?? '').trim().toLowerCase();
  return (v === 'true' || v === '1') && Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * ADR 1146 D6 — the `openwop.run_id` a span carries. telemetry.md: a run's spans
 * carry "the run's id", and a v2 client knows the run only by its WIRE id
 * (`<tenant>/<opaque>`, ids.schema.json), so a collector filtering by the id the
 * client saw found nothing. Found 2026-11-17 by the suite's own legs against this
 * host: every host leg `blocked`. The bare stored id stays when the family is off.
 */
export function spanRunId(runId: string, tenantId: string | undefined): string {
  return telemetryFamilyEnabled() && tenantId ? toWireRunId(runId, tenantId) : runId;
}

/** The OTel GenAI semantic-conventions version the model-call span maps to. */
export const GEN_AI_SEMCONV = '1.37.0';

/** The v2 `telemetry` record, or null while the family is not claimed. */
export function v2TelemetryFamily(since: string, until: string): Record<string, unknown> | null {
  if (!telemetryFamilyEnabled()) return null;
  return { telemetry: { status: 'experimental', since, until, witness: 'witnessable-gated', otlp: { protocols: [...OTLP_PROTOCOLS] }, genAiSemconv: GEN_AI_SEMCONV } };
}

/**
 * ADR 1146 D5 — test-seam-only sabotage, so the RFC 0262 GenAI leg can be shown
 * red on this host (RFC 0263 §C). `drop-usage` leaves the token counts off the
 * model-call span. Never read outside `OPENWOP_TEST_SEAM_ENABLED`.
 */
function genAiSabotage(env: NodeJS.ProcessEnv = process.env): 'drop-usage' | null {
  return env.OPENWOP_TEST_SEAM_ENABLED === 'true' && env.OPENWOP_SABOTAGE_GENAI === 'drop-usage' ? 'drop-usage' : null;
}

/**
 * The `gen_ai.*` attributes of one model call, or `{}` while the family is off.
 * Built from ids and counts only: there is no parameter here through which a
 * prompt, a completion or a system prompt could reach a span.
 */
export function genAiSpanAttributes(provider: string, usage?: { inputTokens?: number; outputTokens?: number }): Record<string, string | number> {
  if (!telemetryFamilyEnabled()) return {};
  const out: Record<string, string | number> = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider };
  if (usage && genAiSabotage() !== 'drop-usage') {
    if (typeof usage.inputTokens === 'number') out['gen_ai.usage.input_tokens'] = usage.inputTokens;
    if (typeof usage.outputTokens === 'number') out['gen_ai.usage.output_tokens'] = usage.outputTokens;
  }
  return out;
}

/**
 * telemetry.md §Export: "A run created with a valid W3C `traceparent` MUST emit
 * its spans in that trace." The run executes after `POST /runs` has returned, so
 * the request's context is gone. The run keeps the context it was created under
 * (`metadata.traceContext`), and the run span is parented on it here. Null means
 * keep today's parenting: the family is off, or the run came with no context.
 */
export function runSpanParent(metadata: Record<string, unknown> | null | undefined): Context | null {
  if (!telemetryFamilyEnabled()) return null;
  const tc = runTraceContext(metadata);
  return tc ? propagation.extract(ROOT_CONTEXT, traceHeaders(tc)) : null;
}
