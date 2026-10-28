/**
 * OTel tracer init (createTracer) — in-repo regression guard for the
 * OpenTelemetry 2.x SDK migration.
 *
 * createTracer runs as the FIRST line of createApp(), unguarded against the
 * rest of boot, so a broken SDK-init contract (e.g. the removed `new Resource()`
 * / `addSpanProcessor()` APIs) would crash the whole host rather than just
 * disable tracing. These tests prove the 2.0 init path (resourceFromAttributes +
 * NodeTracerProvider({ spanProcessors })) constructs successfully — i.e. it does
 * NOT silently fall into the fail-open catch — and that the provider is actually
 * REGISTERED (a recording span), without the cross-repo conformance collector.
 *
 * Determinism (wave 61): `tracer.ts` caches its tracer in a module-level
 * singleton, so under `--sequence.shuffle` a case that ran after another got the
 * cached tracer and never constructed anything. Every case now imports a FRESH
 * module (`vi.resetModules` + dynamic import). The OTel API's global provider
 * lives on `globalThis`, outside the module registry, so each case also clears
 * it (`trace.disable()`) — otherwise a recording span could come from a provider
 * an EARLIER case registered (probe tr-register was vacuous for that reason
 * plus a `toBeTruthy()` span check that a no-op tracer satisfies).
 */

import { context, propagation, trace } from '@opentelemetry/api';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

type TracerModule = typeof import('../src/observability/tracer.js');
let mod: TracerModule;

beforeEach(async () => {
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
});

describe('createTracer (OTel 2.x init)', () => {
  it('initializes the OTel 2.0 SDK without falling into the fail-open catch', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tracer = mod.createTracer({
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
    const first = mod.createTracer({ serviceName: 'x', serviceVersion: '1', consoleExporter: false });
    const second = mod.createTracer({ serviceName: 'y', serviceVersion: '2', consoleExporter: false });
    expect(second).toBe(first);
    expect(mod.getTracer()).toBe(first);
  });

  it('produces a usable span once the provider is registered', () => {
    mod.createTracer({ serviceName: 'span-svc', serviceVersion: '1', consoleExporter: false });
    const span = mod.getTracer().startSpan('unit-test-span');
    // A no-op tracer (provider never registered) returns a non-recording span
    // with the all-zero invalid trace id; a registered provider records.
    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanContext().traceId).not.toBe('0'.repeat(32));
    span.end();
  });
});
