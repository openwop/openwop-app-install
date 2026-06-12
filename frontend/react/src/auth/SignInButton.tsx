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
import { Link } from 'react-router-dom';
import { Modal } from '../ui/Modal.js';
import { BuildingIcon, UserIcon } from '../ui/icons/index.js';
import { useAuth } from './useAuth.js';
import { finalizeFirebaseSession } from './finalizeSession.js';
import { getMe, logout, type User as DurableUser } from '../features/users/usersClient.js';
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
          return 'Sign-in was cancelled.';
        case 'popup-blocked':
          return 'Your browser blocked the sign-in popup. Allow popups for app.openwop.dev and try again.';
        case 'operation-not-allowed':
          return 'This provider isn\'t enabled for the deployment. The maintainer needs to turn it on in the Firebase Console.';
        case 'network-request-failed':
          return 'Network error reaching the identity provider. Check your connection and try again.';
        default:
          return `Sign-in failed: ${m[1]}.`;
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
  if (id === 'google.com') return 'Google';
  if (id === 'github.com') return 'GitHub';
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
      <h3 className="signin-modal-title">Link your {attempted} account</h3>
      <p className="signin-modal-lede muted">
        <strong>{pendingLink.email}</strong> is already signed up
        {known ? ` with ${pendingLink.existingProviders.map(providerLabel).join(' or ')}` : ''}.
        Sign in with that provider once and we'll attach {attempted} so
        you can use either next time.
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
            Continue with {providerLabel(id)}
          </button>
        );
      })}
      <button
        className="signin-modal-cancel"
        type="button"
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </button>
    </>
  );
}

export function SignInButton() {
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
    ? { name: user.displayName ?? user.email ?? 'Account', email: user.email ?? user.uid, photoURL: user.photoURL ?? null, isFirebase: true }
    : backendUser
    ? { name: backendUser.displayName ?? backendUser.email ?? 'Account', email: backendUser.email ?? backendUser.userId, photoURL: null, isFirebase: false }
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
      <button className="signin-provider signin-google" disabled={busy} type="button" onClick={() => { void attemptSignIn('google'); }}>
        Continue with Google
      </button>
      <button className="signin-provider signin-github" disabled={busy} type="button" onClick={() => { void attemptSignIn('github'); }}>
        Continue with GitHub
      </button>
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
          Sign in
        </button>
        {modalOpen ? (
          <Modal
            label="Sign in"
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
                <h3 className="signin-modal-title">Sign in to <em>save your work</em></h3>
                <p className="signin-modal-lede muted">
                  Workflows + BYOK keys you add after signing in persist across
                  sessions. Anonymous demo state is wiped every 24h.
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
                  Cancel
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
    .split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
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
                My Profile
              </Link>
              <Link
                to="/team"
                className="account-menu-item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <span className="account-menu-item-icon" aria-hidden><BuildingIcon size={16} /></span>
                Team
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
            Sign out
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
              Delete account…
            </button>
          ) : null}
        </div>
      ) : null}
      {confirmingDelete ? (
        <Modal
          label="Confirm account deletion"
          onClose={() => { if (!deleting) setConfirmingDelete(false); }}
          className="signin-modal"
          scrimClassName="signin-modal-backdrop"
        >
            <h3 className="signin-modal-title">Delete your account?</h3>
            <p>
              This permanently removes every workflow, run, event,
              interrupt, and BYOK credential you've stored under{' '}
              <strong>{account.email}</strong>.
              Your Firebase identity record is revoked too. There is
              no undo.
            </p>
            {deleteError ? <div className="alert error">{deleteError}</div> : null}
            <div className="button-row">
              <button
                type="button"
                className="signin-modal-cancel"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
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
                {deleting ? 'Deleting…' : 'Yes, delete everything'}
              </button>
            </div>
        </Modal>
      ) : null}
    </div>
  );
}
