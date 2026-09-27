/**
 * ADR 0118 Phase 6 — browser-side OpenTelemetry bootstrap.
 *
 * Emits client-side spans for the SPA's own `fetch` calls, carrying the standard
 * W3C `traceparent` so a browser-perceived request span becomes the PARENT of the
 * corresponding backend `openwop.chat.turn` / `openwop.provider.dispatch` span for
 * the same call — closing the client-latency-correlation gap the ADR names. Spans
 * carry only route/timing/status by construction (no application body, no PII).
 *
 * This module is LAZY-imported from `main.tsx` ONLY when
 * `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` is set at build time, so all of the OTel-web
 * SDK lands in a separate async chunk and never weighs down the entry bundle.
 *
 * CRITICAL — `propagateTraceHeaderCorsUrls` is intentionally LEFT UNSET. That keeps
 * `traceparent` on same-origin `/api` requests (a Firebase rewrite → Cloud Run,
 * which the server-side `traceContext` middleware reads) while withholding it from
 * the cross-origin `*.run.app` SSE stream — adding a `traceparent` header there
 * would trip a CORS preflight and break SSE.
 */
import { WebTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let initialized = false;

/**
 * Set up the browser tracer once. A double-init is a no-op. Reads the OTLP
 * endpoint from `VITE_OTEL_EXPORTER_OTLP_ENDPOINT`; when unset this is a no-op
 * (the lazy import guard in `main.tsx` normally prevents even reaching here).
 */
export function initBrowserOtel(): void {
  if (initialized) return;
  const endpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  initialized = true;

  const exporter = new OTLPTraceExporter({ url: endpoint });
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'openwop-app-web' }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  // ZoneContextManager keeps span context across async boundaries (fetch/promise
  // chains) in the browser.
  provider.register({ contextManager: new ZoneContextManager() });

  registerInstrumentations({
    // No `propagateTraceHeaderCorsUrls` — see the module header: same-origin /api
    // gets traceparent; the cross-origin *.run.app SSE MUST NOT (CORS preflight
    // would break the stream).
    instrumentations: [new FetchInstrumentation()],
  });
}
