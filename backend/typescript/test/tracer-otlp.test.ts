/**
 * OTel tracer init — OTLP exporter branch (separate file so the module-level
 * tracer singleton is fresh and `OTEL_EXPORTER_OTLP_ENDPOINT` is read on the
 * first init). Validates that the 2.x `SimpleSpanProcessor(new OTLPTraceExporter())`
 * construction path — the one the conformance OTel collector drives in prod —
 * builds without throwing or tripping the fail-open catch. No network: the OTLP
 * exporter only connects on flush, which this test never triggers.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createTracer } from '../src/observability/tracer.js';

describe('createTracer — OTLP exporter branch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('constructs the OTLP HTTP exporter + processor without throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const tracer = createTracer({
      serviceName: 'otlp-svc',
      serviceVersion: '1.0.0',
      consoleExporter: false,
    });
    expect(typeof tracer.startSpan).toBe('function');
    expect(errSpy).not.toHaveBeenCalled();
  });
});
