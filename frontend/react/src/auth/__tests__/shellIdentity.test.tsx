/**
 * KT-AUTH-1 — `useAuth` records the identity the shell MOUNTED as, once.
 *
 * The in-page sign-in decision rests on this baseline. Recording a later emission
 * would make every sign-in look like "the same person", because the SDK reports
 * the new user before `onAuthed` runs, and the anonymous shell would stay on screen.
 *
 * Sabotage that turns it red: remove `recordShellIdentity` from the `onAuthChanged`
 * callback (the restored-session and account-swap cases fail); make the record
 * last-wins (the anonymous, account-swap and watchdog cases fail); remove it from
 * the watchdog (the watchdog case fails); drop the `uid !== null` check (the
 * unknown-user case fails).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AuthUser } from '../firebase.js';

const h = vi.hoisted(() => ({ emit: (_: AuthUser | null): void => undefined }));

vi.mock('../firebase.js', () => ({
  getCurrentUser: () => null,
  isAuthConfigured: () => true,
  onAuthChanged: (cb: (u: AuthUser | null) => void) => { h.emit = cb; return () => undefined; },
  signInWithGithub: vi.fn(), signInWithGoogle: vi.fn(), signOut: vi.fn(),
}));
vi.mock('../finalizeSession.js', () => ({ reconcileRestoredSession: vi.fn(async () => undefined) }));

import { useAuth } from '../useAuth.js';
import { __resetShellIdentityForTest, isShellIdentity } from '../shellIdentity.js';
import { __resetStorageSubjectForTest } from '../../platform/storage.js';

const user = (uid: string): AuthUser => ({ uid, displayName: uid, email: `${uid}@example.test`, photoURL: null, providerIds: ['password'] });
const emit = (u: AuthUser | null): void => { act(() => h.emit(u)); };

beforeEach(() => { __resetShellIdentityForTest(); __resetStorageSubjectForTest(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the identity the shell mounted as (KT-AUTH-1)', () => {
  it('a restored session mounted as that user, through a hard sign-out and back', () => {
    renderHook(() => useAuth());
    emit(user('ada'));
    emit(null);
    emit(user('ada'));
    expect(isShellIdentity('ada')).toBe(true);
  });

  it('an MFA redirect-back mounted anonymous, whoever then signs in', () => {
    renderHook(() => useAuth());
    emit(null);
    emit(user('ada'));
    expect(isShellIdentity('ada')).toBe(false);
  });

  it('an account swap does not move the baseline', () => {
    renderHook(() => useAuth());
    emit(user('ada'));
    emit(null);
    emit(user('grace'));
    expect(isShellIdentity('grace')).toBe(false);
    expect(isShellIdentity('ada')).toBe(true);
  });

  it('a watchdog settle counts as mounting anonymous, even if the SDK answers late', () => {
    vi.useFakeTimers();
    renderHook(() => useAuth());
    act(() => { vi.advanceTimersByTime(5000); });
    emit(user('ada'));
    expect(isShellIdentity('ada')).toBe(false);
  });

  it('an unknown current user is never proof of sameness', () => {
    renderHook(() => useAuth());
    emit(null);
    expect(isShellIdentity(null)).toBe(false);
  });
});
