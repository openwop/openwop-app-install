/**
 * ADR 0118 Phase 6 — browser-OTel bootstrap.
 *
 * The OTel-web SDK is hard to unit-test end-to-end, so the SDK modules are replaced
 * with recording stand-ins and this asserts the ENV GUARD the "unconfigured deploy
 * pays zero cost" invariant depends on:
 *   - with `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` unset the module is a no-op: it never
 *     constructs an exporter or provider and never registers instrumentation;
 *   - with it set (the positive control, without which "nothing was wired" could
 *     pass on a module that never wires anything) it wires ONE exporter at exactly
 *     that endpoint and registers the provider + instrumentation.
 * It does NOT assert the cross-origin `traceparent` withholding the module header
 * calls CRITICAL — that is grade-code row BOTEL-CORS-1, outside this file's claim.
 *
 * Sabotage (wave 51): deleting `if (!endpoint) return;` reds case 2 (it did NOT when
 * this case only asserted `not.toThrow()` — probe w51g1-bo-guard was vacuous);
 * ignoring the endpoint or not registering reds case 1.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const otel = vi.hoisted(() => ({
  exporter: vi.fn<(opts: { url: string }) => void>(),
  provider: vi.fn<(opts: unknown) => void>(),
  register: vi.fn<(opts: unknown) => void>(),
  instrumentations: vi.fn<(opts: unknown) => void>(),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class { constructor(opts: { url: string }) { otel.exporter(opts); } },
}));
vi.mock('@opentelemetry/sdk-trace-web', () => ({
  WebTracerProvider: class {
    constructor(opts: unknown) { otel.provider(opts); }
    register(opts: unknown): void { otel.register(opts); }
  },
  BatchSpanProcessor: class { constructor(_exporter: unknown) { /* recorded via the provider's options */ } },
}));
vi.mock('@opentelemetry/context-zone', () => ({ ZoneContextManager: class {} }));
vi.mock('@opentelemetry/instrumentation', () => ({
  registerInstrumentations: (opts: unknown): void => { otel.instrumentations(opts); },
}));
vi.mock('@opentelemetry/instrumentation-fetch', () => ({ FetchInstrumentation: class {} }));

beforeEach(() => {
  otel.exporter.mockReset();
  otel.provider.mockReset();
  otel.register.mockReset();
  otel.instrumentations.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  // `initialized` is module state: each case gets a fresh module.
  vi.resetModules();
});

describe('browserOtel (ADR 0118 Phase 6)', () => {
  it('is dynamically importable and, when the endpoint IS set, wires one exporter at exactly that URL', async () => {
    vi.stubEnv('VITE_OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otel.example.test/v1/traces');
    const { initBrowserOtel } = await import('../browserOtel.js');
    initBrowserOtel();
    expect(otel.exporter).toHaveBeenCalledTimes(1);
    expect(otel.exporter).toHaveBeenCalledWith({ url: 'https://otel.example.test/v1/traces' });
    expect(otel.provider).toHaveBeenCalledTimes(1);
    expect(otel.register).toHaveBeenCalledTimes(1);
    expect(otel.instrumentations).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (does not throw, wires nothing) when VITE_OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    vi.stubEnv('VITE_OTEL_EXPORTER_OTLP_ENDPOINT', '');
    const { initBrowserOtel } = await import('../browserOtel.js');
    expect(() => initBrowserOtel()).not.toThrow();
    expect(otel.exporter).not.toHaveBeenCalled();
    expect(otel.provider).not.toHaveBeenCalled();
    expect(otel.register).not.toHaveBeenCalled();
    expect(otel.instrumentations).not.toHaveBeenCalled();
  });
});
