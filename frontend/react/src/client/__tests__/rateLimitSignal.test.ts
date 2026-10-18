/**
 * ADR 0640 — the rate-limit signal: one observer at the fetch seam, one
 * deadline, extended-not-replaced, parsed from Retry-After.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetRateLimitObserver, _resetRateLimitSignal, getRateLimitState, installRateLimitObserver,
  noteRateLimited, retryAfterMs, subscribeRateLimited,
} from '../rateLimitSignal.js';

const res = (status: number, retryAfter?: string): Response =>
  new Response(null, { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });

beforeEach(() => { _resetRateLimitSignal(); _resetRateLimitObserver(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('retryAfterMs', () => {
  it('reads delta-seconds, floors at 1s, defaults to 5s, and accepts an HTTP-date', () => {
    expect(retryAfterMs('7')).toBe(7_000);
    expect(retryAfterMs('0')).toBe(1_000);
    expect(retryAfterMs(null)).toBe(5_000);
    expect(retryAfterMs('garbage')).toBe(5_000);
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(retryAfterMs('Mon, 07 Sep 2026 12:00:09 GMT', now)).toBe(9_000);
  });
});

describe('noteRateLimited', () => {
  it('ignores non-429s, publishes a deadline on 429, and only ever EXTENDS it', () => {
    const seen: Array<number | null> = [];
    const off = subscribeRateLimited((s) => seen.push(s ? s.untilMs : null));
    const t0 = 1_000_000;
    noteRateLimited(res(200), t0);
    expect(getRateLimitState()).toBeNull();
    noteRateLimited(res(429, '10'), t0);
    noteRateLimited(res(429, '3'), t0 + 100); // a shorter window inside the burst does not shrink it
    noteRateLimited(res(429, '30'), t0 + 200);
    expect(seen).toEqual([t0 + 10_000, t0 + 30_200]);
    off();
  });
});

describe('installRateLimitObserver', () => {
  it('wraps window.fetch once, forwards untouched, returns the same response, and notes same-origin 429s only', async () => {
    // The real jsdom window (no laundered stub): its own location decides
    // same-origin. window.fetch is restored in `finally`.
    const orig = window.fetch;
    try {
      const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
      const r429 = res(429, '4');
      window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push([input, init]); return r429; });
      installRateLimitObserver(window);
      const wrapped = window.fetch;
      installRateLimitObserver(window); // idempotent
      expect(window.fetch, 'a second install must not wrap the wrapper').toBe(wrapped);
      const before = Date.now();
      const out = await window.fetch('/api/v1/runs', { method: 'GET' });
      const after = Date.now();
      expect(out).toBe(r429);
      expect(calls).toEqual([['/api/v1/runs', { method: 'GET' }]]);
      const s = getRateLimitState();
      // Retry-After: 4 — bounded on BOTH sides, so the 5 s default cannot pass for it.
      expect(s).not.toBeNull();
      expect(s!.untilMs).toBeGreaterThanOrEqual(before + 4_000);
      expect(s!.untilMs).toBeLessThanOrEqual(after + 4_000);

      _resetRateLimitSignal();
      await window.fetch('https://elsewhere.example/thing');
      expect(getRateLimitState(), 'a foreign origin 429 is not this app being limited').toBeNull();
    } finally {
      window.fetch = orig;
    }
  });
});
