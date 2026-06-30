/**
 * OTel tracer init under the `openwop.*` semantic-namespace.
 *
 * Console exporter by default — production deployers swap for OTLP HTTP
 * by setting OTEL_EXPORTER_OTLP_ENDPOINT (the standard OTel env var).
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor, type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let tracer: Tracer | null = null;
/** ADR 0118 Phase 4 — resolve the optional Langfuse OTLP sink from host env. Returns
 *  the `{ url, headers }` for an OTLPTraceExporter when all three keys are set, else null.
 *  The Basic-auth credential is built from the host-side keys (never on the wire); the
 *  URL carries NO secret. Exported for unit coverage. */
export function langfuseSinkConfig(env: NodeJS.ProcessEnv): { url: string; headers: Record<string, string> } | null {
  const host = env.OPENWOP_LANGFUSE_HOST;
  const pub = env.OPENWOP_LANGFUSE_PUBLIC_KEY;
  const sec = env.OPENWOP_LANGFUSE_SECRET_KEY;
  if (!host || !pub || !sec) return null;
  const auth = Buffer.from(`${pub}:${sec}`).toString('base64');
  return { url: `${host.replace(/\/+$/, '')}/api/public/otel/v1/traces`, headers: { Authorization: `Basic ${auth}` } };
}

let provider: NodeTracerProvider | null = null;

export interface TracerInit {
  serviceName: string;
  serviceVersion: string;
  consoleExporter: boolean;
}

export function createTracer(init: TracerInit): Tracer {
  if (tracer) return tracer;

  // Telemetry must never crash the host: createTracer runs as the FIRST line of
  // createApp(), so any SDK init throw would take down boot. On failure we log
  // and fall through to the API's global (no-op) tracer — the app boots, just
  // without tracing.
  try {
    // OTel 2.0: span processors are passed to the NodeTracerProvider
    // constructor (`provider.addSpanProcessor()` was removed), so build the
    // list first.
    const spanProcessors: SpanProcessor[] = [];

    if (init.consoleExporter) {
      spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }

    // OTLP HTTP exporter — wired when OTEL_EXPORTER_OTLP_ENDPOINT is set.
    // Used by the conformance suite's in-suite OTel collector
    // (`OPENWOP_OTEL_COLLECTOR=true`) and by production deployers
    // forwarding to their own collector.
    //
    // Processor choice (DATA-4): `BatchSpanProcessor` by default — `Simple`
    // flushes synchronously per span, so a ~10ms collector roundtrip × hundreds
    // of node spans per run would dominate request-tail latency. The conformance
    // collector (`OPENWOP_OTEL_COLLECTOR=true`) and an explicit
    // `OPENWOP_OTEL_SIMPLE_PROCESSOR=true` opt back into immediate-flush `Simple`
    // so a 1–2-span fixture is readable without waiting for a batch tick. Same
    // OTLP exporter underneath either way.
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const wantImmediate =
        process.env.OPENWOP_OTEL_COLLECTOR === 'true' ||
        process.env.OPENWOP_OTEL_SIMPLE_PROCESSOR === 'true';
      const exporter = new OTLPTraceExporter();
      spanProcessors.push(
        wantImmediate ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter),
      );
    }

    // ADR 0118 Phase 4 — optional Langfuse sink. Langfuse ingests OTLP traces, so it is
    // a SECOND OTLP exporter on the SAME span tree (no second instrumentation, no new
    // dep). Gated on the host-env Langfuse keys (basic-auth credentials that stay
    // HOST-SIDE — never on the wire); the spans carry only the Phase-1 allowlisted
    // attributes (no prompt bytes, no credential). Absent env ⇒ no sink.
    const langfuse = langfuseSinkConfig(process.env);
    if (langfuse) {
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter(langfuse)));
    }

    // OTel 2.0: `new Resource()` was removed in favour of the factory.
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: init.serviceName,
        [ATTR_SERVICE_VERSION]: init.serviceVersion,
        'openwop.protocol_version': '1.1',
      }),
      spanProcessors,
    });

    provider.register();
  } catch (err) {
    console.error('[otel] tracer init failed — continuing without tracing:', err);
  }

  tracer = trace.getTracer('openwop.workflow-engine-sample', init.serviceVersion);
  return tracer;
}

export function getTracer(): Tracer {
  if (!tracer) throw new Error('Tracer not initialized — call createTracer() at boot');
  return tracer;
}

/**
 * Flush and tear down the tracer provider on graceful shutdown (DATA-4).
 * `BatchSpanProcessor` buffers spans, so without this the in-flight batch is
 * lost when the process exits on SIGTERM/SIGINT. Best-effort + bounded: a
 * stuck exporter must not block process exit. No-op if tracing never inited.
 */
export async function shutdownTracer(): Promise<void> {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch (err) {
    console.error('[otel] tracer shutdown/flush failed:', err);
  } finally {
    provider = null;
  }
}
