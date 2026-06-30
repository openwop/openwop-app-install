/**
 * OTel tracer init (createTracer) — in-repo regression guard for the
 * OpenTelemetry 2.x SDK migration.
 *
 * createTracer runs as the FIRST line of createApp(), unguarded against the
 * rest of boot, so a broken SDK-init contract (e.g. the removed `new Resource()`
 * / `addSpanProcessor()` APIs) would crash the whole host rather than just
 * disable tracing. These tests prove the 2.0 init path (resourceFromAttributes +
 * NodeTracerProvider({ spanProcessors })) constructs successfully — i.e. it does
 * NOT silently fall into the fail-open catch — without needing the cross-repo
 * conformance OTel collector.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createTracer, getTracer } from '../src/observability/tracer.js';

describe('createTracer (OTel 2.x init)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('initializes the OTel 2.0 SDK without falling into the fail-open catch', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tracer = createTracer({
      serviceName: 'test-svc',
      serviceVersion: '9.9.9',
      consoleExporter: true, // exercises SimpleSpanProcessor + ConsoleSpanExporter construction
    });
    expect(typeof tracer.startSpan).toBe('function');
    // The fail-open catch logs via console.error; a clean init never trips it.
    // This is what actually validates resourceFromAttributes + the constructor
    // `spanProcessors` API in-repo.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('is idempotent — repeated calls return the cached tracer', () => {
    const first = createTracer({ serviceName: 'x', serviceVersion: '1', consoleExporter: false });
    const second = createTracer({ serviceName: 'y', serviceVersion: '2', consoleExporter: false });
    expect(second).toBe(first);
    expect(getTracer()).toBe(first);
  });

  it('produces a usable span once the provider is registered', () => {
    // Silence the ConsoleSpanExporter's stdout on span end.
    vi.spyOn(console, 'dir').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const span = getTracer().startSpan('unit-test-span');
    expect(span).toBeTruthy();
    span.end();
  });
});
