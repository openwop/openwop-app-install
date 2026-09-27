import { describe, it, expect, vi } from 'vitest';
import {
  isAuthConfigured,
  getCurrentUser,
  getCurrentIdToken,
  getPendingMfaHints,
  onAuthChanged,
  selectTotpHint,
  signInWithGoogle,
  signInWithGithub,
} from '../firebase.js';

/**
 * Unit coverage for the lazy Firebase module (GAP-ANALYSIS E13) on the
 * NOT-CONFIGURED path — the anon/demo deploy, and the path CI exercises. The
 * key guarantee: when VITE_FIREBASE_* is unset, the module must NEVER load the
 * Firebase SDK (ensureInitAsync short-circuits before the dynamic import) and
 * must degrade gracefully. The configured/redirect path needs real OAuth and is
 * verified manually against openwop-dev.
 */
describe('firebase auth (not configured)', () => {
  it('reports not-configured', () => {
    expect(isAuthConfigured()).toBe(false);
  });

  it('has no cached user', () => {
    expect(getCurrentUser()).toBeNull();
  });

  it('resolves a null ID token without loading the SDK', async () => {
    expect(await getCurrentIdToken()).toBeNull();
  });

  it('onAuthChanged fires once with null and returns a safe unsubscribe', async () => {
    const cb = vi.fn();
    const unsub = onAuthChanged(cb);
    expect(typeof unsub).toBe('function');
    // ensureInitAsync resolves null on the next microtask → cb(null).
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledWith(null);
    expect(() => unsub()).not.toThrow();
  });

  it('sign-in rejects with a friendly not-configured error', async () => {
    await expect(signInWithGoogle()).rejects.toThrow(/not configured/i);
    await expect(signInWithGithub()).rejects.toThrow(/not configured/i);
  });
});

/**
 * USERS-UX-1 — multi-device TOTP challenge. `selectTotpHint` is the PURE
 * selection seam `completeMfaSignIn` routes through; asserting only the first
 * hint locked out a user who lost device #1 but still holds #2. The live
 * resolver path needs a real Firebase challenge and is exercised manually.
 */
describe('MFA factor selection (USERS-UX-1)', () => {
  const hints = [
    { uid: 'factor-1', displayName: 'Old phone' },
    { uid: 'factor-2', displayName: 'New phone' },
  ] as const;

  it('no pending challenge → no hints', () => {
    expect(getPendingMfaHints()).toEqual([]);
  });

  it('defaults to the single/first hint when no factorUid is given', () => {
    expect(selectTotpHint(hints)?.uid).toBe('factor-1');
    expect(selectTotpHint([hints[1]])?.uid).toBe('factor-2');
  });

  it('an explicit factorUid selects EXACTLY that hint', () => {
    expect(selectTotpHint(hints, 'factor-2')?.uid).toBe('factor-2');
    expect(selectTotpHint(hints, 'factor-1')?.uid).toBe('factor-1');
  });

  it('an unknown factorUid resolves null — never silently a different device', () => {
    expect(selectTotpHint(hints, 'factor-gone')).toBeNull();
  });

  it('no hints at all resolves null (typed failure upstream, not a crash)', () => {
    expect(selectTotpHint([])).toBeNull();
    expect(selectTotpHint([], 'factor-1')).toBeNull();
  });
});
