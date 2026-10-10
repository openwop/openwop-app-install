/**
 * Header sign-in / account UI.
 *
 * Three states:
 *   1. Firebase not configured → render nothing
 *   2. Configured, no user     → "Sign in" button → modal with Google + GitHub
 *   3. Signed in               → avatar + dropdown (display name, profile/team
 *                                links, accessibility preferences, language,
 *                                "Sign out", "Delete account")
 *
 * Provider buttons use the official brand colors and SVG marks; tone-
 * matched to the existing dark builder palette.
 */

import { Suspense, lazy, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import i18n from '../i18n/index.js';
import { getFormatLocale } from '../i18n/format.js';
import { BuildingIcon, EyeIcon, GlobeIcon, LogOutIcon, TrashIcon, UserIcon } from '../ui/icons/index.js';
import { localeOptionCount } from '../i18n/LanguageSwitcher.js';
import { publishAccountPresence } from './accountPresence.js';
import { refreshBackendSession, setBackendSessionUser, useBackendSession } from './backendSession.js';
import {
  claimHardSignOutPresenter,
  clearHardSignOutReason,
  releaseHardSignOutPresenter,
  useHardSignOutReason,
} from './hardSignOut.js';
import { useAuth } from './useAuth.js';
import { finalizeFirebaseSession } from './finalizeSession.js';
import { logout } from '../features/users/usersClient.js';
import { useDemoMode } from '../client/useDemoMode.js';
import { brand } from '../brand/brand.js';
import {
  ExistingProviderSignInError,
  getRedirectState,
  signInWithGithub,
  signInWithGoogle,
  signInWithMicrosoft,
} from './firebase.js';
import type { PendingLink, SignInProvider } from './AccountDialogs.js';

// CLNP-8 — the dialogs load on demand (see AccountDialogs.tsx for what moved and why
// it is safe). One loader, shared by the four lazies and the prefetch, so a warmed
// chunk serves every dialog.
const loadAccountDialogs = (): Promise<typeof import('./AccountDialogs.js')> => import('./AccountDialogs.js');
const SignInDialog = lazy(() => loadAccountDialogs().then((m) => ({ default: m.SignInDialog })));
const DeleteAccountDialog = lazy(() => loadAccountDialogs().then((m) => ({ default: m.DeleteAccountDialog })));
const A11yPrefsDialog = lazy(() => loadAccountDialogs().then((m) => ({ default: m.A11yPrefsDialog })));
const LanguageDialog = lazy(() => loadAccountDialogs().then((m) => ({ default: m.LanguageDialog })));
/** Warm the dialogs chunk. Fire-and-forget: a failed prefetch is a non-event — the
 *  lazy import retries when a dialog actually opens. */
function prefetchAccountDialogs(): void {
  void loadAccountDialogs().catch(() => undefined);
}

function describeSignInError(err: unknown): string {
  if (err instanceof ExistingProviderSignInError) return err.message;
  if (err instanceof Error) {
    // Strip the `Firebase: Error (auth/...)` wrapper so the modal
    // doesn't surface a code that means nothing to the visitor.
    const m = err.message.match(/^Firebase: Error \(auth\/([a-z-]+)\)\.?$/);
    if (m) {
      switch (m[1]) {
        case 'popup-closed-by-user':
        case 'cancelled-popup-request':
          return i18n.t('auth:signInCancelled');
        case 'popup-blocked':
          return i18n.t('auth:popupBlocked', { domain: brand.primaryDomain });
        case 'operation-not-allowed':
          return i18n.t('auth:providerNotEnabled');
        case 'network-request-failed':
          return i18n.t('auth:networkErrorIdp');
        default:
          return i18n.t('auth:signInFailed', { code: m[1] });
      }
    }
    return err.message;
  }
  return String(err);
}

export function SignInButton() {
  const { t } = useTranslation('auth');
  const { user, loading, isConfigured, signOut } = useAuth();
  // ADR 0196 Gate A / DEMO-6: the "save your work / wiped every 24h" framing is
  // TRUE on the demo host (anon sessions are ephemeral) but demo-speak on a
  // clean install — the modal copy forks on the host's demo flag.
  const demo = useDemoMode();
  // profiles is always-on (graduated — see backend/features/profiles/feature.ts §Correction);
  // The backend session is the canonical signed-in truth (ADR 0003): OIDC, a
  // bound durable User, or an email/password session all resolve through `/me`.
  // Firebase `user` is one INPUT (the OIDC mechanism); a password session has no
  // Firebase user, so we track the durable record separately and treat EITHER as
  // signed in. The durable record lives in the SHARED backendSession store —
  // every mounted SignInButton (Sidebar, AccessHub, invite pages) renders the
  // same snapshot, so a sign-in through one updates them all (grade-pass fix:
  // per-instance /me state used to split-brain the accountPresence signal).
  const backendUser = useBackendSession().user;
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // AUTH-2: the popover declares role=menu — give it the matching keyboard
  // contract (Escape + outside-click close, ↑↓ roving) without forcing the
  // header/Link structure into ui/Menu.
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const root = menuRootRef.current;
    const items = (): HTMLElement[] => Array.from(root?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        root?.querySelector<HTMLElement>('.account-menu-trigger')?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
        return;
      }
      // USERS-UX-10 — WAI-ARIA menu pattern: Home/End jump to the first/last item.
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const list = items();
        (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
      }
    };
    const onDown = (e: MouseEvent): void => {
      if (root && !root.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [menuOpen]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Accessibility preferences live in the account menu (moved from the Sidebar
  // footer); the modal reuses the shared A11yPrefsFields (one store, one UI).
  const [a11yOpen, setA11yOpen] = useState(false);
  // Language preference — a menuitem that opens a small dialog (never an
  // inline select inside role=menu; grade-pass AM-1/AM-2).
  const [langOpen, setLangOpen] = useState(false);
  // Focus home for every dialog launched FROM the menu: the menuitem opener
  // unmounts when the menu closes, so the modal's own restore-to-opener finds
  // nothing (WCAG 2.4.3) — restore to the always-mounted trigger instead.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusToTrigger = (): void => { triggerRef.current?.focus(); };

  // Publish whether an account menu is available so the Sidebar knows to show
  // its fallback accessibility/language controls when there ISN'T one
  // (signed-out / Firebase-unconfigured). `null` while auth is still resolving.
  const accountPresent: boolean | null = !isConfigured ? false : loading ? null : Boolean(user || backendUser);
  useEffect(() => { publishAccountPresence(accountPresent); }, [accountPresent]);
  // Warm the dialogs chunk once the page is idle, so the first open does not wait
  // on the network (the ChatTab prefetch precedent).
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(prefetchAccountDialogs);
    else { const id = window.setTimeout(prefetchAccountDialogs, 2000); return () => window.clearTimeout(id); }
    return undefined;
  }, []);

  /**
   * Subscribe to the boot-time redirect-result promise exactly once.
   * MUST run before any conditional return so the hook count stays
   * stable across renders (Rules of Hooks).
   *
   * If we landed on this page coming back from a sign-in redirect,
   * the result is reported here and we either:
   *   - open the modal in link-mode (cross-provider collision), OR
   *   - run the post-sign-in migration (success), OR
   *   - surface a friendly error (other auth failure).
   */
  useEffect(() => {
    let cancelled = false;
    void getRedirectState().then(async (state) => {
      if (cancelled) return;
      if (state.kind === 'link-required') {
        const err = state.error;
        setPendingLink({
          email: err.email,
          existingProviders: err.existingProviders,
          attemptedProvider: err.attemptedProvider,
        });
        setModalOpen(true);
      } else if (state.kind === 'success') {
        // Same backend handshake as the email/password path (ADR 0026):
        // token → /migrate-tenant → /oidc/bind → /me. Best-effort.
        // Only publish a user we actually READ. On `ok: false` the store keeps
        // whatever it already knew and stays unresolved, so the mount-time
        // `refreshBackendSession()` can try again — publishing null here would
        // record "this account has no durable user" from a failed request.
        const finalized = await finalizeFirebaseSession();
        if (finalized.ok) setBackendSessionUser(finalized.user);
        setModalOpen(false);
        setPendingLink(null);
      } else if (state.kind === 'error') {
        setError(describeSignInError(state.error));
        setModalOpen(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Detect an EXISTING backend session on load — a returning email/password user
  // (no Firebase user) or an already-bound OIDC user. `/me` is the canonical
  // signed-in check; best-effort (401/404 when there's no session / users off).
  // Deduped module-wide: N mounted instances share one round-trip.
  useEffect(() => { void refreshBackendSession(); }, []);

  // ADR 0621 D5 / USERS-UX-13 — a mid-session refusal (account disabled /
  // erased / sessions revoked) or a self "sign out everywhere" publishes a
  // reason; the FIRST mounted instance to claim it opens the sign-in modal with
  // the reason as an announced error Notice. Others stay quiet (one modal).
  const signOutReason = useHardSignOutReason();
  const presenterId = useRef<symbol>(Symbol('signin-presenter'));
  const presentingReason = signOutReason !== null && claimHardSignOutPresenter(presenterId.current);
  useEffect(() => {
    if (presentingReason) setModalOpen(true);
  }, [presentingReason]);
  useEffect(() => {
    const id = presenterId.current;
    return () => releaseHardSignOutPresenter(id);
  }, []);
  const dismissReason = (): void => { if (signOutReason !== null) clearHardSignOutReason(); };

  if (!isConfigured || loading) return null;

  /** The unified signed-in identity: Firebase user (OIDC) OR the durable backend
   *  User (password / bound session). EITHER means signed in. */
  const account = user
    ? { name: user.displayName ?? user.email ?? t('accountFallbackName'), email: user.email ?? user.uid, photoURL: user.photoURL ?? null, isFirebase: true }
    : backendUser
    ? { name: backendUser.displayName ?? backendUser.email ?? t('accountFallbackName'), email: backendUser.email ?? backendUser.userId, photoURL: null, isFirebase: false }
    : null;

  /** Reconcile the SPA session after a backend (password) auth + close the modal. */
  async function onAuthed(): Promise<void> {
    await refreshBackendSession();
    dismissReason();
    setModalOpen(false);
  }

  /**
   * Kick off a redirect-based sign-in. The page navigates away to
   * Firebase's auth handler; control returns via a fresh page load,
   * where `processRedirectResult()` (called at boot) reports the
   * outcome via the `getRedirectState()` promise that the mount
   * effect above subscribes to. This function only initiates the
   * redirect; the browser handles the rest.
   */
  async function attemptSignIn(which: SignInProvider): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await (which === 'google' ? signInWithGoogle() : which === 'microsoft' ? signInWithMicrosoft() : signInWithGithub());
      // signInWithRedirect resolves AFTER initiating the redirect.
      // The browser navigates within a tick; the modal stays open
      // until then.
    } catch (err) {
      setError(describeSignInError(err));
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <>
        <button
          className="signin-trigger"
          onClick={() => setModalOpen(true)}
          onMouseEnter={prefetchAccountDialogs}
          onFocus={prefetchAccountDialogs}
          type="button"
        >
          {t('signIn')}
        </button>
        {modalOpen ? (
          <Suspense fallback={null}>
            <SignInDialog
              pendingLink={pendingLink}
              busy={busy}
              error={error}
              demo={demo}
              refusalReason={presentingReason && signOutReason ? signOutReason : null}
              onAttempt={attemptSignIn}
              onAuthed={onAuthed}
              onCancelLink={() => { setPendingLink(null); setError(null); }}
              onClose={() => { dismissReason(); setModalOpen(false); }}
            />
          </Suspense>
        ) : null}
      </>
    );
  }

  // Signed-in: avatar + dropdown (account = Firebase OIDC user OR durable backend User)
  const initials = account.name
    .split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toLocaleUpperCase(getFormatLocale());
  return (
    <div className="account-menu" ref={menuRootRef}>
      <button
        ref={triggerRef}
        className="account-menu-trigger"
        onClick={() => setMenuOpen((v) => !v)}
        onMouseEnter={prefetchAccountDialogs}
        onFocus={prefetchAccountDialogs}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={account.name}
        type="button"
      >
        {account.photoURL ? (
          <img src={account.photoURL} alt="" className="account-menu-avatar" />
        ) : (
          <span className="account-menu-initials">{initials}</span>
        )}
        <span className="account-menu-name">{account.name}</span>
      </button>
      {menuOpen ? (
        <div className="account-menu-popover" role="menu">
          <div className="account-menu-header">
            <div className="account-menu-displayname">{account.name}</div>
            <div className="account-menu-email muted">{account.email}</div>
          </div>
          {account ? (
            <>
              <Link
                to="/profile"
                className="account-menu-item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <span className="account-menu-item-icon" aria-hidden><UserIcon size={16} /></span>
                {t('myProfile')}
              </Link>
              <Link
                to="/team"
                className="account-menu-item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <span className="account-menu-item-icon" aria-hidden><BuildingIcon size={16} /></span>
                {t('team')}
              </Link>
              <button
                className="account-menu-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setA11yOpen(true);
                }}
              >
                <span className="account-menu-item-icon" aria-hidden><EyeIcon size={16} /></span>
                {t('a11y:prefsButton')}
              </button>
              {/* Language opens in a small dialog, NOT as an inline <select> —
                  a select is an invalid role=menu child (SR menu navigation
                  can't reach it) and the ↑↓ roving handler above would yank
                  focus off it (grade-pass a11y blockers AM-1/AM-2). Hidden at a
                  single declared locale, same as the old footer switcher. */}
              {localeOptionCount() > 1 && (
                <button
                  className="account-menu-item"
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setLangOpen(true);
                  }}
                >
                  <span className="account-menu-item-icon" aria-hidden><GlobeIcon size={16} /></span>
                  {t('common:language')}
                </button>
              )}
            </>
          ) : null}
          <button
            className="account-menu-item"
            role="menuitem"
            onClick={async () => {
              // Clear BOTH sessions: Firebase (OIDC) + the backend cookie (password
              // or OIDC-bound). Either may be present.
              await signOut().catch(() => {});
              await logout();
              setBackendSessionUser(null);
              setMenuOpen(false);
            }}
            type="button"
          >
            <span className="account-menu-item-icon" aria-hidden><LogOutIcon size={16} /></span>
            {t('signOut')}
          </button>
          {account.isFirebase ? (
            <button
              className="account-menu-item account-menu-danger"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setConfirmingDelete(true);
              }}
              type="button"
            >
              <span className="account-menu-item-icon" aria-hidden><TrashIcon size={16} /></span>
              {t('deleteAccount')}
            </button>
          ) : null}
        </div>
      ) : null}
      {confirmingDelete ? (
        <Suspense fallback={null}>
          <DeleteAccountDialog email={account.email} onClose={() => { setConfirmingDelete(false); restoreFocusToTrigger(); }} />
        </Suspense>
      ) : null}
      {a11yOpen ? (
        <Suspense fallback={null}>
          <A11yPrefsDialog onClose={() => { setA11yOpen(false); restoreFocusToTrigger(); }} />
        </Suspense>
      ) : null}
      {langOpen ? (
        <Suspense fallback={null}>
          <LanguageDialog onClose={() => { setLangOpen(false); restoreFocusToTrigger(); }} />
        </Suspense>
      ) : null}
    </div>
  );
}
