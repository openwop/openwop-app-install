/** ADR 0512 — the stamp is consumed exactly once and can never go stale. */
import { describe, expect, it } from 'vitest';
import { setNavSource, consumeNavSource } from '../navSource.js';

describe('navSource', () => {
  it('first consumption without a stamp reads deep-link; later ones in-app-link', () => {
    expect(consumeNavSource()).toBe('deep-link');
    expect(consumeNavSource()).toBe('in-app-link');
  });
  it('a stamp is consumed exactly once', () => {
    setNavSource('palette');
    expect(consumeNavSource()).toBe('palette');
    expect(consumeNavSource()).toBe('in-app-link'); // not sticky
  });
  it('a newer stamp overwrites an unconsumed one (no stale attribution)', () => {
    setNavSource('sidebar');
    setNavSource('admin-rail');
    expect(consumeNavSource()).toBe('admin-rail');
  });
});
