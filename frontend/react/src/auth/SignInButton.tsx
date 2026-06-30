/**
 * Header sign-in / account UI.
 *
 * Three states:
 *   1. Firebase not configured → render nothing
 *   2. Configured, no user     → "Sign in" button → modal with Google + GitHub
 *   3. Signed in               → avatar + dropdown (display name, "Sign out",
 *                                "Delete account" placeholder for P3.6.5)
 *
 * Provider buttons use the official brand colors and SVG marks; tone-
 * matched to the existing dark builder palette.
 */

import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import i18n from '../i18n/index.js';
import { getFormatLocale } from '../i18n/format.js';
import { Modal } from '../ui/Modal.js';
import { BuildingIcon, LogOutIcon, TrashIcon, UserIcon } from '../ui/icons/index.js';
import { useAuth } from './useAuth.js';
import { finalizeFirebaseSession } from './finalizeSession.js';
import { getMe, logout, type User as DurableUser } from '../features/users/usersClient.js';
import { GoogleMark } from '../brand/vendor/GoogleMark.js';
import { GithubMark } from '../brand/vendor/GithubMark.js';
import { AuthCard } from './AuthCard.js';
import {
  ExistingProviderSignInError,
  getRedirectState,
  signInWithGithub,
  signInWithGoogle,
} from './firebase.js';
import { deleteAccount, RequiresRecentLoginError } from './deleteAccount.js';

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
          return i18n.t('auth:popupBlocked');
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

interface PendingLink {
  email: string;
  existingProviders: readonly string[];
  attemptedProvider: 'google.com' | 'github.com';
}

function providerLabel(id: string): string {
  if (id === 'google.com') return i18n.t('auth:providerGoogle');
  if (id === 'github.com') return i18n.t('auth:providerGithub');
  return id;
}

/**
 * Body shown after Firebase rejects sign-in with
 * `auth/account-exists-with-different-credential`. Explains the
 * collision in plain language and offers a single-click flow to:
 *   1. Sign in with the existing provider.
 *   2. Link the rejected credential to the same Firebase user.
 *
 * When `existingProviders` is empty (email-enumeration protection
 * stripped the list), both buttons are offered.
 */
function LinkAccountBody(props: {
  pendingLink: PendingLink;
  busy: boolean;
  error: string | null;
  onContinue: (which: 'google' | 'github') => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('auth');
  const { pendingLink, busy, error, onContinue, onCancel } = props;
  const attempted = providerLabel(pendingLink.attemptedProvider);
  const known = pendingLink.existingProviders.length > 0;
  // Render only the existing provider's button when we know it.
  // Otherwise fall back to both, the user picks the one they
  // remember signing up with.
  const choices = known
    ? pendingLink.existingProviders
    : ['google.com', 'github.com'].filter((p) => p !== pendingLink.attemptedProvider);
  return (
    <>
      <h3 className="signin-modal-title">{t('linkYourAccount', { provider: attempted })}</h3>
      <p className="signin-modal-lede muted">
        {known ? (
          <Trans
            t={t}
            i18nKey="alreadySignedUpKnown"
            values={{
              email: pendingLink.email,
              providers: pendingLink.existingProviders.map(providerLabel).join(` ${t('or')} `),
              attempted,
            }}
            components={{ 0: <strong /> }}
          />
        ) : (
          <Trans
            t={t}
            i18nKey="alreadySignedUpUnknown"
            values={{ email: pendingLink.email, attempted }}
            components={{ 0: <strong /> }}
          />
        )}
      </p>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {choices.map((id) => {
        const which = id === 'google.com' ? 'google' : 'github';
        const cls = id === 'google.com' ? 'signin-provider signin-google' : 'signin-provider signin-github';
        return (
          <button
            key={id}
            className={cls}
            disabled={busy}
            type="button"
            onClick={() => onContinue(which)}
          >
            {t('continueWith', { provider: providerLabel(id) })}
          </button>
        );
      })}
      <button
        className="signin-modal-cancel"
        type="button"
        disabled={busy}
        onClick={onCancel}
      >
        {t('cancel')}
      </button>
    </>
  );
}

export function SignInButton() {
  const { t } = useTranslation('auth');
  const { user, loading, isConfigured, signOut } = useAuth();
  // profiles is always-on (graduated — see backend/features/profiles/feature.ts §Correction);
  // The backend session is the canonical signed-in truth (ADR 0003): OIDC, a
  // bound durable User, or an email/password session all resolve through `/me`.
  // Firebase `user` is one INPUT (the OIDC mechanism); a password session has no
  // Firebase user, so we track the durable record separately and treat EITHER as
  // signed in.
  const [backendUser, setBackendUser] = useState<DurableUser | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
        setBackendUser(await finalizeFirebaseSession());
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
  useEffect(() => {
    let cancelled = false;
    void getMe().then((u) => { if (!cancelled) setBackendUser(u); }).catch(() => { /* no session */ });
    return () => { cancelled = true; };
  }, []);

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
    setBackendUser(await getMe().catch(() => null));
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
  async function attemptSignIn(which: 'google' | 'github'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await (which === 'google' ? signInWithGoogle() : signInWithGithub());
      // signInWithRedirect resolves AFTER initiating the redirect.
      // The browser navigates within a tick; the modal stays open
      // until then.
    } catch (err) {
      setError(describeSignInError(err));
      setBusy(false);
    }
  }

  const oidcButtons = (
    <div className="u-grid u-gap-1">
      <button className="signin-provider signin-google" disabled={busy} aria-busy={busy} type="button" onClick={() => { void attemptSignIn('google'); }}>
        <GoogleMark />
        {t('continueWithGoogle')}
      </button>
      <button className="signin-provider signin-github" disabled={busy} aria-busy={busy} type="button" onClick={() => { void attemptSignIn('github'); }}>
        <GithubMark />
        {t('continueWithGithub')}
      </button>
      {/* §11: surface a visible, announced "still signing in" status while the
       *  redirect round-trip is in flight (the page navigates away, then returns
       *  via processRedirectResult on the next load). */}
      <div className="signin-status muted" role="status" aria-live="polite">
        {busy ? 'Signing in… you may be redirected to your provider.' : ''}
      </div>
    </div>
  );

  if (!account) {
    return (
      <>
        <button
          className="signin-trigger"
          onClick={() => setModalOpen(true)}
          type="button"
        >
          {t('signIn')}
        </button>
        {modalOpen ? (
          <Modal
            label={t('signIn')}
            onClose={() => setModalOpen(false)}
            className="signin-modal"
            scrimClassName="signin-modal-backdrop"
          >
            {pendingLink ? (
              <LinkAccountBody
                pendingLink={pendingLink}
                busy={busy}
                error={error}
                onContinue={attemptSignIn}
                onCancel={() => { setPendingLink(null); setError(null); }}
              />
            ) : (
              <>
                <h3 className="signin-modal-title">
                  <Trans t={t} i18nKey="signInToSaveTitle" components={{ 0: <em /> }} />
                </h3>
                <p className="signin-modal-lede muted">
                  {t('signInToSaveLede')}
                </p>
                {error ? <div className="alert error" role="alert">{error}</div> : null}
                <AuthCard
                  oidc={oidcButtons}
                  passwordEnabled={true}
                  onAuthed={onAuthed}
                />
                <button
                  className="signin-modal-cancel"
                  type="button"
                  onClick={() => setModalOpen(false)}
                >
                  {t('cancel')}
                </button>
              </>
            )}
          </Modal>
        ) : null}
      </>
    );
  }

  // Signed-in: avatar + dropdown (account = Firebase OIDC user OR durable backend User)
  const initials = account.name
    .split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toLocaleUpperCase(getFormatLocale());
  return (
    <div className="account-menu">
      <button
        className="account-menu-trigger"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
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
              setBackendUser(null);
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
                setDeleteError(null);
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
        <Modal
          label={t('confirmAccountDeletion')}
          onClose={() => { if (!deleting) setConfirmingDelete(false); }}
          className="signin-modal"
          scrimClassName="signin-modal-backdrop"
        >
            <h3 className="signin-modal-title">{t('deleteAccountTitle')}</h3>
            <p>
              <Trans
                t={t}
                i18nKey="deleteAccountBody"
                values={{ email: account.email }}
                components={{ 0: <strong /> }}
              />
            </p>
            {deleteError ? <div className="alert error">{deleteError}</div> : null}
            <div className="button-row">
              <button
                type="button"
                className="signin-modal-cancel"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="signin-provider signin-danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    const result = await deleteAccount();
                    console.warn('openwop: account deleted', result);
                    setConfirmingDelete(false);
                    // Force reload — the SPA's caches reference a
                    // tenant id that no longer exists.
                    window.location.href = '/';
                  } catch (err) {
                    if (err instanceof RequiresRecentLoginError) {
                      setDeleteError(err.message);
                    } else {
                      setDeleteError(err instanceof Error ? err.message : String(err));
                    }
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? t('deleting') : t('deleteEverything')}
              </button>
            </div>
        </Modal>
      ) : null}
    </div>
  );
}
