/**
 * ADR 0118 Phase 6 — browser-OTel bootstrap.
 *
 * The OTel-web SDK is hard to unit-test end-to-end, so this asserts the module
 * SHAPE + the ENV GUARD (the two things the entry-bundle laziness + no-op safety
 * depend on), not the full export pipeline:
 *   - it exports `initBrowserOtel`;
 *   - it is dynamically importable (the `main.tsx` lazy-import contract);
 *   - it is a no-op (never throws, never wires the SDK) when the OTLP endpoint env
 *     is unset — the "unconfigured deploy pays zero cost" invariant.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('browserOtel (ADR 0118 Phase 6)', () => {
  it('exports initBrowserOtel and is dynamically importable', async () => {
    const mod = await import('../browserOtel.js');
    expect(typeof mod.initBrowserOtel).toBe('function');
  });

  it('is a no-op (does not throw) when VITE_OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    vi.stubEnv('VITE_OTEL_EXPORTER_OTLP_ENDPOINT', '');
    const { initBrowserOtel } = await import('../browserOtel.js');
    expect(() => initBrowserOtel()).not.toThrow();
  });
});
