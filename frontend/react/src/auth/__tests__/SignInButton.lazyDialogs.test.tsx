/**
 * CLNP-8 — the account surface's dialogs load lazily (AccountDialogs.tsx), while
 * everything with a side effect stays in the eager SignInButton. What this pins:
 *
 *  1. A Firebase REDIRECT result opens the sign-in dialog with NO click. The
 *     subscription must stay eager: it runs on the page load that returns from a
 *     provider, and if it moved behind the lazy chunk a returning user's error or
 *     account-link prompt would never appear.
 *  2. The trigger still opens the sign-in dialog (lazy content, awaited).
 *  3. Each account-menu dialog (accessibility, language, delete) opens from the
 *     menu as THAT dialog, and closing it returns focus to the always-mounted trigger (WCAG 2.4.3).
 *
 * The lazy boundary makes the dialogs asynchronous, so every dialog assertion
 * awaits (`findBy…`) — a synchronous query here would pass only by accident.
 * Every dialog is identified by its ACCESSIBLE NAME (the Modal `label`): an
 * anonymous `findByRole('dialog')` passed with the wrong lazy export wired in.
 *
 * Sabotage that turns it red: drop the `state.kind === 'error'` branch (1);
 * wire `SignInDialog` to another AccountDialogs export (2); drop
 * `restoreFocusToTrigger()` from any menu dialog's `onClose` (3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser, RedirectState } from '../firebase.js';
import type { UseAuth } from '../useAuth.js';

const h = vi.hoisted(() => {
  const state: { user: AuthUser | null; redirect: RedirectState } = { user: null, redirect: { kind: 'none' } };
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
    signInWithGoogle: vi.fn(), signInWithGithub: vi.fn(), signInWithMicrosoft: vi.fn(),
    microsoftSignInEnabled: () => false,
  };
});
vi.mock('../backendSession.js', () => ({
  useBackendSession: () => ({ user: null }),
  refreshBackendSession: vi.fn(async () => undefined),
  setBackendSessionUser: vi.fn(),
}));
vi.mock('../../client/useDemoMode.js', () => ({ useDemoMode: () => false }));
vi.mock('../finalizeSession.js', () => ({ finalizeFirebaseSession: vi.fn(async () => ({ ok: false })) }));
vi.mock('../../features/users/usersClient.js', () => ({ logout: vi.fn(async () => undefined) }));

import { SignInButton } from '../SignInButton.js';

function mount(): void {
  render(<MemoryRouter><SignInButton /></MemoryRouter>);
}

beforeEach(() => {
  h.user = null;
  h.redirect = { kind: 'none' };
  // The sign-in dialog's AuthCard reads discovery; a unit test must not reach the
  // network (ADR 0661) — the guard honours a file's own fetch stub.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SignInButton — lazy dialogs, eager side effects (CLNP-8)', () => {
  it('a redirect ERROR opens the sign-in dialog with no click (the subscription stayed eager)', async () => {
    h.redirect = { kind: 'error', error: new Error('provider exploded') };
    mount();
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog.textContent).toContain('provider exploded');
  });

  it('the trigger opens the lazily-loaded sign-in dialog', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();
  });

  it('account-menu dialogs open from the menu and return focus to the trigger on close', async () => {
    h.user = { displayName: 'Ada Lovelace', email: 'ada@example.test', uid: 'u1', photoURL: null, providerIds: ['google.com'] };
    mount();
    const trigger = await screen.findByRole('button', { name: 'Ada Lovelace' });

    // [menuitem, the dialog it must open] — language rides `localeOptionCount() > 1`
    // (4 declared locales), so it is offered here.
    const cases: Array<[RegExp, string]> = [
      [/accessibility|a11y/i, 'Accessibility'],
      [/^language$/i, 'Language'],
      [/delete account/i, 'Confirm account deletion'],
    ];
    for (const [item, dialogName] of cases) {
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('menuitem', { name: item }));
      const dialog = await screen.findByRole('dialog', { name: dialogName });
      fireEvent.keyDown(dialog, { key: 'Escape' });
      // Under load (~60) the lazy dialog's unmount outlasts waitFor's 1 s default (#4176).
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
      expect(document.activeElement, `focus returns to the trigger after ${String(item)}`).toBe(trigger);
    }
  });
});
