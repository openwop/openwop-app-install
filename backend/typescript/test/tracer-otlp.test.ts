/**
 * OTel tracer init — OTLP exporter branch. Validates that the 2.x construction
 * path the conformance OTel collector and production deployers drive (an
 * `OTLPTraceExporter` wrapped in a span processor) builds without throwing or
 * tripping the fail-open catch, and that it is taken ONLY when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No network: the OTLP exporter only
 * connects on flush, which this test never triggers.
 *
 * CORRECTED 2026-10-23 (wave 61): this header used to say
 * `SimpleSpanProcessor(new OTLPTraceExporter())`. The default is
 * `BatchSpanProcessor` (DATA-4); `Simple` only under `OPENWOP_OTEL_COLLECTOR` /
 * `OPENWOP_OTEL_SIMPLE_PROCESSOR` (tracer.ts, the OTLP branch). And the case
 * asserted only "no throw", which skipping the branch entirely satisfied (probe
 * tro-branch vacuous): the exporter class is now wrapped to COUNT
 * constructions, and both sides of the env gate are asserted on a fresh module.
 */

import { context, propagation, trace } from '@opentelemetry/api';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

const otlp = vi.hoisted(() => ({ constructed: 0 }));

vi.mock('@opentelemetry/exporter-trace-otlp-http', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opentelemetry/exporter-trace-otlp-http')>();
  class CountingOTLPTraceExporter extends orig.OTLPTraceExporter {
    constructor(...args: ConstructorParameters<typeof orig.OTLPTraceExporter>) {
      super(...args);
      otlp.constructed += 1;
    }
  }
  return { ...orig, OTLPTraceExporter: CountingOTLPTraceExporter };
});

type TracerModule = typeof import('../src/observability/tracer.js');
let mod: TracerModule;
const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OPENWOP_LANGFUSE_HOST', 'OPENWOP_LANGFUSE_PUBLIC_KEY', 'OPENWOP_LANGFUSE_SECRET_KEY',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) { const v = process.env[k]; if (v !== undefined) saved[k] = v; delete process.env[k]; }
  otlp.constructed = 0;
  trace.disable();
  context.disable();
  propagation.disable();
  vi.resetModules();
  mod = await import('../src/observability/tracer.js');
});

afterEach(async () => {
  await mod.shutdownTracer();
  trace.disable();
  context.disable();
  propagation.disable();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { delete process.env[k]; const v = saved[k]; if (v !== undefined) process.env[k] = v; delete saved[k]; }
});

describe('createTracer — OTLP exporter branch', () => {
  it('constructs the OTLP HTTP exporter + processor without throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const tracer = mod.createTracer({
      serviceName: 'otlp-svc',
      serviceVersion: '1.0.0',
      consoleExporter: false,
    });
    expect(typeof tracer.startSpan).toBe('function');
    expect(errSpy).not.toHaveBeenCalled();
    // The branch was taken: exactly one exporter (the Langfuse sink is unset).
    expect(otlp.constructed).toBe(1);
  });

  it('does NOT construct the OTLP exporter when the endpoint is unset', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mod.createTracer({ serviceName: 'otlp-off', serviceVersion: '1.0.0', consoleExporter: false });
    expect(errSpy).not.toHaveBeenCalled();
    expect(otlp.constructed).toBe(0);
  });
});
