/**
 * Unit tests for the coalesce-and-cache helper behind the chat read-fan-out /
 * rate-limit fix (client/requestCache.ts). Verifies the two properties the fix
 * relies on: concurrent identical reads collapse to ONE loader call, and a
 * rejected load is never cached (so a 429 storm self-heals).
 *
 * #927 (the load-time 429 wall). Breaks it: N identical reads in one burst, a
 * TTL that never expires, an invalidate() that does not force a re-fetch, or a
 * rejected load pinned in the cache. Tenant-change invalidation is pinned in
 * tenantChange.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedRead, invalidate, clearRequestCache } from '../requestCache.js';

afterEach(() => {
  clearRequestCache();
  vi.useRealTimers();
});

describe('cachedRead: in-flight coalescing', () => {
  it('collapses concurrent identical calls into one loader invocation', async () => {
    const loader = vi.fn(async () => 'v');
    const [a, b, c] = await Promise.all([
      cachedRead('k', 0, loader),
      cachedRead('k', 0, loader),
      cachedRead('k', 0, loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(['v', 'v', 'v']);
  });

  it('TTL 0 re-invokes the loader once the in-flight call has resolved', async () => {
    const loader = vi.fn(async () => 'v');
    await cachedRead('k', 0, loader);
    await cachedRead('k', 0, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('cachedRead: TTL caching', () => {
  it('serves a cached value within the TTL, re-fetches after it expires', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => 'v');
    await cachedRead('k', 1000, loader);
    await cachedRead('k', 1000, loader);
    expect(loader).toHaveBeenCalledTimes(1); // second served from cache
    vi.advanceTimersByTime(1001);
    await cachedRead('k', 1000, loader);
    expect(loader).toHaveBeenCalledTimes(2); // expired → re-fetched
  });

  it('invalidate() forces the next read to re-fetch', async () => {
    const loader = vi.fn(async () => 'v');
    await cachedRead('k', 60_000, loader);
    invalidate('k');
    await cachedRead('k', 60_000, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('cachedRead: failures self-heal', () => {
  it('does not cache a rejected load; a later call retries and can succeed', async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce('ok');
    await expect(cachedRead('k', 60_000, loader)).rejects.toThrow('429');
    await expect(cachedRead('k', 60_000, loader)).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects all concurrent callers when the single in-flight load fails', async () => {
    const loader = vi.fn(async () => { throw new Error('boom'); });
    const results = await Promise.allSettled([
      cachedRead('k', 0, loader),
      cachedRead('k', 0, loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});
