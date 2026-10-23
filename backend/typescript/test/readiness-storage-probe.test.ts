/**
 * DATA-5 — the /readiness storage probe is bounded by a timeout so a
 * pool-exhausted / hung DB returns a fast 503 instead of hanging past
 * Cloud Run's external timeout. Exercises `storageProbeError` directly
 * with a kvGet that resolves, throws, and never settles.
 *
 * The timeout case runs on FAKE timers, so it asserts the probe settles at the
 * configured 50 ms — not merely "within 5 s" (a probe that ignored the env and
 * waited 50× longer passed the old wall-clock bound: 8fw1g3-rds-timeout-slow,
 * vacuous in round 1). Sabotage-witnessed: the error message passthrough
 * (rds-message), the timeout length (rds-timeout-slow-r2), success → null
 * (rds-success).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // rather than hanging the request — at 50 ms, not later.
    vi.useFakeTimers();
    try {
      let settled: string | null | undefined;
      const pending = storageProbeError({
        kvGet: () => new Promise<string | null>(() => {}), // never resolves
      }).then((v) => { settled = v; });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled, 'still pending 1 ms before the configured timeout').toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe('storage probe timed out after 50ms');
    } finally {
      vi.useRealTimers();
    }
  });
});
