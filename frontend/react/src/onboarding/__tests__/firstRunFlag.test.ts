/**
 * Per-user first-run dismissal flags (ADR 0188 pattern, shared helper). Pins:
 *  - no uid → treated as dismissed (never nag an anonymous/loading session);
 *  - the flag is per-uid AND per-feature (no cross-leak between users or surfaces);
 *  - dismiss is idempotent and the key shape is the stable ADR 0188 string.
 *  - a storage failure (private mode) fails CLOSED — treated as dismissed, never a
 *    nag — and dismissing never throws (the module's stated contract; w51 r2 added
 *    the case after probe fr-storage-fail stayed green).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstRunKey, isFirstRunDismissed, dismissFirstRun } from '../firstRunFlag.js';

afterEach(() => localStorage.clear());

describe('firstRunFlag', () => {
  it('builds the stable ADR 0188 key shape', () => {
    expect(firstRunKey('vendorSetup', 'user-1')).toBe('openwop-app.onboarding.vendorSetup.user-1');
    expect(firstRunKey('getStarted', 'user-1')).toBe('openwop-app.onboarding.getStarted.user-1');
  });

  it('treats a missing uid as dismissed (never nags anonymous/loading)', () => {
    expect(isFirstRunDismissed('getStarted', undefined)).toBe(true);
    expect(isFirstRunDismissed('getStarted', null)).toBe(true);
    expect(isFirstRunDismissed('getStarted', '')).toBe(true);
  });

  it('is not dismissed for a signed-in user until dismissed, then stays dismissed', () => {
    expect(isFirstRunDismissed('getStarted', 'u1')).toBe(false);
    dismissFirstRun('getStarted', 'u1');
    expect(isFirstRunDismissed('getStarted', 'u1')).toBe(true);
    // Idempotent (header claim): a second dismiss leaves exactly the one stable key.
    dismissFirstRun('getStarted', 'u1');
    expect(isFirstRunDismissed('getStarted', 'u1')).toBe(true);
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('openwop-app.onboarding.getStarted.u1');
  });

  it('is per-uid — one user dismissing does not dismiss another', () => {
    dismissFirstRun('getStarted', 'u1');
    expect(isFirstRunDismissed('getStarted', 'u1')).toBe(true);
    expect(isFirstRunDismissed('getStarted', 'u2')).toBe(false);
  });

  it('is per-feature — dismissing one surface leaves the other showing', () => {
    dismissFirstRun('vendorSetup', 'u1');
    expect(isFirstRunDismissed('vendorSetup', 'u1')).toBe(true);
    expect(isFirstRunDismissed('getStarted', 'u1')).toBe(false);
  });

  it('a storage failure fails closed (dismissed) and dismiss never throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      expect(isFirstRunDismissed('getStarted', 'u1')).toBe(true);
      expect(() => dismissFirstRun('getStarted', 'u1')).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('dismiss is a no-op without a uid', () => {
    dismissFirstRun('getStarted', undefined);
    expect(localStorage.length).toBe(0);
  });
});
