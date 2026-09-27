/**
 * Per-user first-run dismissal flags (ADR 0188 pattern, shared helper). Pins:
 *  - no uid → treated as dismissed (never nag an anonymous/loading session);
 *  - the flag is per-uid AND per-feature (no cross-leak between users or surfaces);
 *  - dismiss is idempotent and the key shape is the stable ADR 0188 string.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

  it('dismiss is a no-op without a uid', () => {
    dismissFirstRun('getStarted', undefined);
    expect(localStorage.length).toBe(0);
  });
});
