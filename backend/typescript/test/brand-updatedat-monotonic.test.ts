/**
 * Brand `updatedAt` is the optimistic-concurrency token (R2 BR-SP-5), so every
 * save must MOVE it. A millisecond clock does not: two saves in one millisecond
 * shared a token and a stale editor's save passed the check, silently
 * overwriting the other edit (the intermittent `brand-route` BR-SP-5 failure).
 */
import { describe, expect, it } from 'vitest';
import { nextUpdatedAt } from '../src/features/brand/brandService.js';

describe('nextUpdatedAt — strictly increasing', () => {
  const t = Date.parse('2026-10-06T04:00:00.000Z');
  it('a save in the SAME millisecond still moves the token', () => {
    const prev = new Date(t).toISOString();
    expect(nextUpdatedAt(prev, t)).toBe('2026-10-06T04:00:00.001Z');
  });
  it('a previous value ahead of the clock (skew) is still passed', () => {
    expect(nextUpdatedAt('2026-10-06T04:00:05.000Z', t)).toBe('2026-10-06T04:00:05.001Z');
  });
  it('normally it is just now', () => {
    expect(nextUpdatedAt('2026-10-06T03:59:59.000Z', t)).toBe('2026-10-06T04:00:00.000Z');
  });
  it('a missing or unparseable previous value falls back to now', () => {
    expect(nextUpdatedAt(undefined, t)).toBe('2026-10-06T04:00:00.000Z');
    expect(nextUpdatedAt('not a date', t)).toBe('2026-10-06T04:00:00.000Z');
  });
});
