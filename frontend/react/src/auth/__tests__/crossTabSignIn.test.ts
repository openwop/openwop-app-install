/**
 * Issue 5842 — a tab that is already open follows a sign-in made in another tab.
 *
 * Only a same-tab sign-in reloaded (`SignInButton.onAuthed`), so an open tab kept the
 * previous account's mount-time reads (the workspace list) until reloaded by hand.
 * Pins: a different signed-in account than the shell mounted as reloads; the same
 * account does not; this tab's own sign-in (dialog open) does not; a shell that
 * mounted anonymous does not (the watchdog's null must not turn a slow SDK into a
 * reload loop).
 *
 * Issue 6043 — and a sign-OUT elsewhere: a shell that mounted signed in reloads when
 * the SDK reports nobody, unless this tab signed itself out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AuthUser } from '../firebase.js';

const h = vi.hoisted(() => ({ emit: (_u: AuthUser | null) => undefined as void, reload: vi.fn() }));
vi.mock('../firebase.js', async (orig) => ({
  ...(await orig<typeof import('../firebase.js')>()),
  isAuthConfigured: () => true,
  getCurrentUser: () => null,
  onAuthChanged: (cb: (u: AuthUser | null) => void) => { h.emit = cb; return () => undefined; },
}));
vi.mock('../reloadIntoSession.js', () => ({ reloadIntoSession: () => h.reload() }));
vi.mock('../finalizeSession.js', () => ({ reconcileRestoredSession: vi.fn(async () => undefined) }));
vi.mock('../localContentAdoption.js', () => ({ adoptLocalContentForSubject: vi.fn() }));

const { useAuth } = await import('../useAuth.js');
const { __resetShellIdentityForTest, beginInPageSignIn, noteOwnSignOut } = await import('../shellIdentity.js');
const user = (uid: string): AuthUser => ({ uid, email: `${uid}@acme.test`, displayName: uid, photoURL: null } as unknown as AuthUser);

beforeEach(() => { __resetShellIdentityForTest(); h.reload.mockReset(); });
afterEach(cleanup);

describe('issue 5842 — a sign-in in another tab', () => {
  it('a different account than the shell mounted as reloads the tab into it', () => {
    renderHook(() => useAuth());
    h.emit(user('alice'));
    expect(h.reload).not.toHaveBeenCalled();
    h.emit(user('bob'));
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('the same account signing in again does not reload', () => {
    renderHook(() => useAuth());
    h.emit(user('alice'));
    h.emit(user('alice'));
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('this tab\'s own sign-in (dialog open) is left to onAuthed', () => {
    renderHook(() => useAuth());
    h.emit(user('alice'));
    const end = beginInPageSignIn();
    h.emit(user('bob'));
    expect(h.reload).not.toHaveBeenCalled();
    end();
  });

  it('a shell that mounted anonymous does not reload, either way (no slow-SDK loop)', () => {
    renderHook(() => useAuth());
    h.emit(null);
    h.emit(user('alice'));
    h.emit(null);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('issue 6043 — a sign-out in another tab reloads the signed-in shell out of the old account', () => {
    renderHook(() => useAuth());
    h.emit(user('alice'));
    h.emit(null);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('issue 6043 — this tab\'s own sign-out keeps its own exit', () => {
    renderHook(() => useAuth());
    h.emit(user('alice'));
    noteOwnSignOut();
    h.emit(null);
    expect(h.reload).not.toHaveBeenCalled();
  });
});
