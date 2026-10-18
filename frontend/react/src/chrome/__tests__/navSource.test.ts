/** ADR 0512 — the stamp is consumed exactly once and can never go stale.
 *  The module holds state (`pending`, `navigatedBefore`), so every case gets a
 *  fresh instance: the deep-link case is only meaningful on a first navigation,
 *  and must not depend on running before the others. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mod: typeof import('../navSource.js');

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../navSource.js');
});

describe('navSource', () => {
  it('first consumption without a stamp reads deep-link; later ones in-app-link', () => {
    expect(mod.consumeNavSource()).toBe('deep-link');
    expect(mod.consumeNavSource()).toBe('in-app-link');
  });
  it('a stamp is consumed exactly once', () => {
    mod.setNavSource('palette');
    expect(mod.consumeNavSource()).toBe('palette');
    expect(mod.consumeNavSource()).toBe('in-app-link'); // not sticky
  });
  it('a newer stamp overwrites an unconsumed one (no stale attribution)', () => {
    mod.setNavSource('sidebar');
    mod.setNavSource('admin-rail');
    expect(mod.consumeNavSource()).toBe('admin-rail');
  });
});
