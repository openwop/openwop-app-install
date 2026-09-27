/**
 * Deferred Phase D (SHELL-8) — the tenant-change broadcast seam. Pins:
 *   1. `fireAuthChanged()` notifies onAuthChange subscribers WITHOUT a token
 *      change (a workspace switch rebinds the tenant; the token is unchanged);
 *   2. the request-coalesce cache drops on the broadcast (tenant reads —
 *      agents/roster/boards — must not survive a switch).
 */
import { describe, expect, it } from 'vitest';
import { fireAuthChanged, onAuthChange } from '../config.js';
import { cachedRead } from '../requestCache.js';

describe('tenant-change broadcast (Phase D)', () => {
  it('fireAuthChanged notifies subscribers without a token change', () => {
    let fired = 0;
    const off = onAuthChange(() => { fired += 1; });
    fireAuthChanged();
    expect(fired).toBe(1);
    off();
    fireAuthChanged();
    expect(fired).toBe(1); // unsubscribed
  });

  it('the request cache drops on the broadcast', async () => {
    let loads = 0;
    const loader = async () => { loads += 1; return `v${loads}`; };
    const a = await cachedRead('phase-d-test', 60_000, loader);
    const b = await cachedRead('phase-d-test', 60_000, loader);
    expect(a).toBe('v1');
    expect(b).toBe('v1'); // cached
    fireAuthChanged();
    const c = await cachedRead('phase-d-test', 60_000, loader);
    expect(c).toBe('v2'); // reloaded after the tenant change
  });
});
