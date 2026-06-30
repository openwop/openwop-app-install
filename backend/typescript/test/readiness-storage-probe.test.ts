/**
 * DATA-5 — the /readiness storage probe is bounded by a timeout so a
 * pool-exhausted / hung DB returns a fast 503 instead of hanging past
 * Cloud Run's external timeout. Exercises `storageProbeError` directly
 * with a kvGet that resolves, throws, and never settles.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storageProbeError } from '../src/routes/health.js';

const savedTimeout = process.env.OPENWOP_READINESS_PROBE_TIMEOUT_MS;

beforeEach(() => {
  // Keep the probe timeout tiny so the "hangs forever" case resolves quickly.
  process.env.OPENWOP_READINESS_PROBE_TIMEOUT_MS = '50';
});

afterEach(() => {
  if (savedTimeout === undefined) delete process.env.OPENWOP_READINESS_PROBE_TIMEOUT_MS;
  else process.env.OPENWOP_READINESS_PROBE_TIMEOUT_MS = savedTimeout;
});

describe('storageProbeError', () => {
  it('returns null when the kv read succeeds', async () => {
    const err = await storageProbeError({ kvGet: async () => null });
    expect(err).toBeNull();
  });

  it('returns the error message when the kv read throws', async () => {
    const err = await storageProbeError({
      kvGet: async () => {
        throw new Error('connection refused');
      },
    });
    expect(err).toBe('connection refused');
  });

  it('times out (does not hang) when the kv read never settles', async () => {
    // The probe reads OPENWOP_READINESS_PROBE_TIMEOUT_MS at call time (set to
    // 50ms in beforeEach), so a never-settling kvGet rejects with a timeout
    // rather than hanging the request.
    const started = Date.now();
    const err = await storageProbeError({
      kvGet: () => new Promise<string | null>(() => {}), // never resolves
    });
    expect(err).toMatch(/timed out/i);
    // Resolves well under the default 5s ceiling (the test runner's own
    // timeout would otherwise fail this if the probe truly hung).
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
