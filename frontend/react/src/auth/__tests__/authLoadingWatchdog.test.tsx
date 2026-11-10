/**
 * First-visit splash hang incident (2026-11-05, fix 07318dfed) —
 * `useAuth().loading` must settle even when the auth SDK never answers. The
 * watchdog is GRADE-DELTA CODE-3; it also settles the storage subject anonymous
 * (ADR 0434 IDN-3: the subject must resolve; IDN-11: `pending` holds a skeleton).
 *
 * Measured on https://myndhyve.ai with a fresh Chromium profile: when the lazy
 * `firebase-*.js` chunk failed to fetch on the first load (or the SDK's first
 * IndexedDB open never completed), `onAuthChanged` never called back, `loading`
 * stayed true for the life of the page, and `/` sat on its neutral splash. The
 * 5 s watchdog fired its "settling anonymous" warning and still left `loading`
 * true. A reload fetched the chunk from cache and worked.
 *
 * Sabotage that turns it red (re-measured by /grade-tests wave 91, TST-GRC-1):
 * remove `setLoading(false)` from the watchdog, move the delay to 4000 or 6000 ms,
 * or drop its `adoptLocalContentForSubject(null)` (the first case fails); have the
 * watchdog also `setUser(null)`, or drop its `!isStorageSubjectResolved()` guard
 * so it re-points an answered user's content at the anonymous subject (the
 * already-answered case fails: a timer must never sign a real user out, in React
 * state OR in local content).
 *
 * Emitting a user from the anonymous subject lazy-imports `adoptAnonContent`;
 * the cases that emit await `vi.dynamicImportSettled()` so that import cannot
 * land in the next case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AuthUser } from '../firebase.js';

const h = vi.hoisted(() => ({ emit: null as ((u: AuthUser | null) => void) | null }));

vi.mock('../firebase.js', () => ({
  getCurrentUser: () => null,
  isAuthConfigured: () => true,
  // Never calls back on its own: the SDK that never answers.
  onAuthChanged: (cb: (u: AuthUser | null) => void) => { h.emit = cb; return () => undefined; },
  signInWithGithub: vi.fn(), signInWithGoogle: vi.fn(), signOut: vi.fn(),
}));
vi.mock('../finalizeSession.js', () => ({ reconcileRestoredSession: vi.fn(async () => undefined) }));

import { useAuth } from '../useAuth.js';
import { __resetShellIdentityForTest } from '../shellIdentity.js';
import { __resetStorageSubjectForTest, getStorageSubject, isStorageSubjectResolved } from '../../platform/storage.js';

const ada: AuthUser = { uid: 'ada', displayName: 'Ada', email: 'ada@example.test', photoURL: null, providerIds: ['password'] };

beforeEach(() => {
  h.emit = null;
  __resetShellIdentityForTest();
  __resetStorageSubjectForTest();
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useAuth loading when the SDK never answers', () => {
  it('settles to signed-out after the watchdog instead of loading forever', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.loading).toBe(true);
    act(() => { vi.advanceTimersByTime(4999); });
    expect(result.current.loading).toBe(true);
    expect(isStorageSubjectResolved()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
    // Signed out in local content too: the subject is settled, anonymous.
    expect(isStorageSubjectResolved()).toBe(true);
    expect(getStorageSubject()).toBeNull();
  });

  it('a late real answer still wins over the watchdog', async () => {
    const { result } = renderHook(() => useAuth());
    act(() => { vi.advanceTimersByTime(5000); });
    expect(getStorageSubject()).toBeNull();
    act(() => { h.emit?.(ada); });
    await vi.dynamicImportSettled();
    expect(result.current.user?.uid).toBe('ada');
    expect(result.current.loading).toBe(false);
    expect(getStorageSubject()).toBe('ada');
  });

  it('the watchdog does not undo an answer that already arrived', async () => {
    const { result } = renderHook(() => useAuth());
    act(() => { h.emit?.(ada); });
    await vi.dynamicImportSettled();
    expect(getStorageSubject()).toBe('ada');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.user?.uid).toBe('ada');
    expect(result.current.loading).toBe(false);
    expect(getStorageSubject()).toBe('ada');
  });
});
