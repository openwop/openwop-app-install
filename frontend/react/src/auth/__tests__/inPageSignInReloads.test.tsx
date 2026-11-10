/**
 * KT-AUTH-1 and KT-AUTH-2 — a sign-in must not leave the anonymous shell on screen.
 *
 * On kicktodo.com an MFA-enrolled account finished its authenticator code and
 * kept seeing "Personal sandbox", 0 of 4 done and no Admin link until a manual
 * reload, with every backend call green. The shell had mounted anonymous and
 * nothing replaced it. `reloadIntoSession()` is that replacement.
 *
 * This drives the real SignInButton + AuthCard and keeps the real ordering, which
 * is what makes the seam easy to break: the SDK reports the user DURING the
 * sign-in, so the dialog unmounts before the handshake ends. The reload must still
 * fire from the orphaned continuation, and must not fire before the handshake is
 * done, or the next load would read a session that is not bound yet.
 *
 * The reload is also only safe when the identity changed. The same person signing
 * back in after a hard sign-out must keep the page: a reload takes the server's
 * definition, so an edit the backend refused would be gone from the builder canvas
 * that told them "Sign in again, then retry" (`shellIdentity.ts`).
 *
 * Sabotage that turns it red: drop `reloadIntoSession()` from `onAuthed` (the
 * anonymous and different-account cases fail); drop the `isShellIdentity` guard
 * (the same-user case fails); invert it (every sign-in case fails); call it before
 * `await refreshBackendSession()` (the ordering assertions fail);
 * call `onAuthed` before `finalizeFirebaseSession` in `AuthCard.doMfa` (the
 * mid-handshake case fails); swallow the rejection and fall through to `onAuthed`
 * in `doMfa` (the wrong-code case fails); drop the invalid-code mapping in
 * `describeAuthError` (the wrong-code case fails: the alert names which error).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type { AuthUser, RedirectState } from '../firebase.js';
import type { UseAuth } from '../useAuth.js';

const h = vi.hoisted(() => {
  const log: string[] = [];
  const state: {
    user: AuthUser | null;
    redirect: RedirectState;
    pendingMfa: boolean;
    log: string[];
    /** Re-render the mounted tree, as `useAuth` does when the SDK emits. */
    emit: () => void;
    finishHandshake: () => void;
    handshake: Promise<void>;
    completeMfa: () => Promise<void>;
    signInEmail: () => Promise<void>;
  } = {
    user: null, redirect: { kind: 'none' }, pendingMfa: false, log,
    emit: () => undefined, finishHandshake: () => undefined, handshake: Promise.resolve(),
    completeMfa: async () => undefined, signInEmail: async () => undefined,
  };
  return state;
});

vi.mock('../useAuth.js', () => ({
  useAuth: (): UseAuth => ({
    user: h.user, loading: false, isConfigured: true,
    signIn: { google: vi.fn(async () => undefined), github: vi.fn(async () => undefined) },
    signOut: vi.fn(async () => undefined),
  }),
}));
vi.mock('../firebase.js', async (orig) => {
  const actual = await orig<typeof import('../firebase.js')>();
  return {
    ...actual,
    getRedirectState: (): Promise<RedirectState> => Promise.resolve(h.redirect),
    getCurrentUser: (): AuthUser | null => h.user,
    hasPendingMfaChallenge: (): boolean => h.pendingMfa,
    getPendingMfaHints: () => [],
    completeMfaSignIn: () => h.completeMfa(),
    signInWithEmail: () => h.signInEmail(),
    microsoftSignInEnabled: () => false,
  };
});
vi.mock('../backendSession.js', () => ({
  useBackendSession: () => ({ user: null }),
  refreshBackendSession: vi.fn(async () => { h.log.push('refresh'); }),
  setBackendSessionUser: vi.fn(),
}));
vi.mock('../../client/useDemoMode.js', () => ({ useDemoMode: () => false }));
vi.mock('../finalizeSession.js', () => ({
  finalizeFirebaseSession: vi.fn(async () => {
    h.log.push('handshake:start');
    await h.handshake;
    h.log.push('handshake:end');
    return { ok: true, user: null };
  }),
}));
vi.mock('../reloadIntoSession.js', () => ({ reloadIntoSession: vi.fn(() => { h.log.push('reload'); }) }));
vi.mock('../../features/users/usersClient.js', () => ({ logout: vi.fn(async () => undefined) }));

import { SignInButton } from '../SignInButton.js';
import { reloadIntoSession } from '../reloadIntoSession.js';
import { __resetShellIdentityForTest, recordShellIdentity } from '../shellIdentity.js';

const ADA: AuthUser = { displayName: 'Ada Lovelace', email: 'ada@example.test', uid: 'u1', photoURL: null, providerIds: ['google.com'] };
/** The SDK emits the signed-in user: `account` turns truthy and the dialog unmounts. */
const sdkEmitsUser = (): void => { h.user = ADA; h.emit(); };
/** The log from the sign-in on; SignInButton also refreshes `/me` once at mount. */
const fromSignIn = (first: string): string[] => {
  const at = h.log.indexOf(first);
  // Absent marker → nothing (a bare `slice(-1)` would hand back the last entry).
  return at === -1 ? [] : h.log.slice(at);
};

function mount(): void {
  const tree = (): JSX.Element => <MemoryRouter><SignInButton /></MemoryRouter>;
  const { rerender } = render(tree());
  h.emit = () => rerender(tree());
}

async function submitPassword(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));
  fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: 'ada@example.test' } });
  const password = await screen.findByLabelText(/password/i);
  fireEvent.change(password, { target: { value: 'correct horse' } });
  const form = password.closest('form');
  if (!form) throw new Error('the password field is not in a form');
  fireEvent.submit(form);
}

async function submitCode(): Promise<void> {
  const field = await screen.findByLabelText(/authenticator code/i);
  fireEvent.change(field, { target: { value: '123456' } });
  const form = field.closest('form');
  if (!form) throw new Error('the code field is not in a form');
  fireEvent.submit(form);
}

beforeEach(() => {
  h.user = null;
  h.log.length = 0;
  h.pendingMfa = false;
  h.redirect = { kind: 'none' };
  h.handshake = new Promise((resolve) => { h.finishHandshake = resolve; });
  // The reported case: this shell mounted anonymous. Cases that differ say so.
  __resetShellIdentityForTest();
  recordShellIdentity(null);
  h.completeMfa = async () => { h.log.push('mfa'); sdkEmitsUser(); };
  h.signInEmail = async () => { h.log.push('email'); sdkEmitsUser(); };
  vi.mocked(reloadIntoSession).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('in-page sign-in leaves the anonymous shell (KT-AUTH-1)', () => {
  it('an MFA redirect-back reloads, after the handshake, though the dialog already unmounted', async () => {
    h.pendingMfa = true;
    h.redirect = { kind: 'error', error: new Error('auth/multi-factor-auth-required') };
    mount();
    await submitCode();

    // The SDK has reported the user and the handshake is still running: the
    // dialog is gone, and a reload now would land on an unbound session.
    await waitFor(() => expect(h.log).toContain('handshake:start'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(reloadIntoSession).not.toHaveBeenCalled();

    h.finishHandshake();
    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
    expect(fromSignIn('mfa')).toEqual(['mfa', 'handshake:start', 'handshake:end', 'refresh', 'reload']);
  });

  it('an email/password sign-in takes the same exit', async () => {
    h.finishHandshake();
    mount();
    await submitPassword();

    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
    expect(fromSignIn('email')).toEqual(['email', 'handshake:start', 'handshake:end', 'refresh', 'reload']);
  });

  it('a rejected code stays on the dialog and does not reload', async () => {
    h.pendingMfa = true;
    h.redirect = { kind: 'error', error: new Error('auth/multi-factor-auth-required') };
    // Production-shaped: the SDK rejects with a FirebaseError carrying `code`,
    // which `describeAuthError` maps to the invalid-code copy.
    h.completeMfa = async () => {
      throw Object.assign(new Error('Firebase: Error (auth/invalid-verification-code).'), { code: 'auth/invalid-verification-code' });
    };
    mount();
    await submitCode();

    const expected = t('auth:errInvalidMfaCode');
    expect(expected).not.toBe('auth:errInvalidMfaCode');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(expected));
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(reloadIntoSession).not.toHaveBeenCalled();
    expect(h.log).not.toContain('handshake:start');
  });

  it('the SAME person signing back in after a hard sign-out keeps the page', async () => {
    __resetShellIdentityForTest();
    recordShellIdentity(ADA.uid);
    h.finishHandshake();
    mount();
    await submitPassword();

    // `refresh` is the step right before the decision: wait for it, then let the
    // continuation finish, or "not called" would pass by being early.
    await waitFor(() => expect(fromSignIn('email')).toContain('refresh'));
    await act(async () => { await Promise.resolve(); });
    expect(fromSignIn('email')).toEqual(['email', 'handshake:start', 'handshake:end', 'refresh']);
    expect(reloadIntoSession).not.toHaveBeenCalled();
  });

  it('a DIFFERENT account signing in after a hard sign-out still reloads', async () => {
    __resetShellIdentityForTest();
    recordShellIdentity('someone-else');
    h.finishHandshake();
    mount();
    await submitPassword();

    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
    expect(fromSignIn('email')).toEqual(['email', 'handshake:start', 'handshake:end', 'refresh', 'reload']);
  });
});

/**
 * KT-AUTH-2 — the plain OAuth redirect-back (no MFA code). The shell mounts as the
 * Firebase user, so the identity rule keeps it, but its mount-time reads went out on
 * the anon cookie before `/migrate-tenant` and `/oidc/bind` finished. MEASURED on
 * app.openwop.dev 2026-11-03 (#5488 browser check 1): signed in as David, workspace
 * still "Personal sandbox", no reload.
 *
 * Sabotage: drop `reloadIntoSession()` from the redirect `success` arm (the first
 * case fails; it is also red against `825eacfb6`'s SignInButton).
 */
describe('a redirect-back sign-in leaves the pre-bind shell (KT-AUTH-2)', () => {
  it('reloads once, after the handshake, though the shell mounted as the signed-in user', async () => {
    h.user = ADA;
    __resetShellIdentityForTest();
    recordShellIdentity(ADA.uid);
    h.redirect = { kind: 'success', linked: false };
    mount();

    await waitFor(() => expect(h.log).toContain('handshake:start'));
    await act(async () => { await Promise.resolve(); });
    expect(reloadIntoSession).not.toHaveBeenCalled();

    h.finishHandshake();
    await waitFor(() => expect(reloadIntoSession).toHaveBeenCalledTimes(1));
    expect(fromSignIn('handshake:start')).toEqual(['handshake:start', 'handshake:end', 'reload']);
  });

  it('an ordinary signed-in page load (no redirect in flight) does not reload', async () => {
    h.user = ADA;
    __resetShellIdentityForTest();
    recordShellIdentity(ADA.uid);
    h.finishHandshake();
    mount();

    await waitFor(() => expect(h.log).toContain('refresh'));
    await act(async () => { await Promise.resolve(); });
    expect(h.log).not.toContain('handshake:start');
    expect(reloadIntoSession).not.toHaveBeenCalled();
  });
});
