/**
 * The account surface's DIALOGS, split out of `SignInButton` so they load on
 * demand instead of riding the entry chunk (CLNP-8).
 *
 * WHAT MOVED, AND WHY IT IS SAFE: only rendered dialog CONTENT — the sign-in
 * modal body (provider buttons, the account-link flow, the password `AuthCard`),
 * the delete-account confirmation, and the accessibility / language dialogs.
 * Each renders only after a user opens it. Everything with a side effect stays in
 * `SignInButton`, eager: the Firebase redirect-result subscription (it must run on
 * the load that returns from a redirect, before any click), the `/me` refresh,
 * the hard-sign-out presenter, the account-presence signal and the menu's
 * keyboard contract. `SignInButton` prefetches this chunk on idle and on trigger
 * hover/focus, so a first open is normally served from cache.
 */
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import i18n from '../i18n/index.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { Button } from '../ui/Button.js';
import { A11yPrefsFields } from '../ui/A11yPrefsControl.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';
import { GoogleMark } from '../brand/vendor/GoogleMark.js';
import { GithubMark } from '../brand/vendor/GithubMark.js';
import { MicrosoftMark } from '../brand/vendor/MicrosoftMark.js';
import { AuthCard } from './AuthCard.js';
import { microsoftSignInEnabled } from './firebase.js';
import { deleteAccount, RequiresRecentLoginError } from './deleteAccount.js';

export type SignInProvider = 'google' | 'github' | 'microsoft';

export interface PendingLink {
  email: string;
  existingProviders: readonly string[];
  attemptedProvider: 'google.com' | 'github.com' | 'microsoft.com';
}

function providerLabel(id: string): string {
  if (id === 'google.com') return i18n.t('auth:providerGoogle');
  if (id === 'github.com') return i18n.t('auth:providerGithub');
  if (id === 'microsoft.com') return i18n.t('auth:providerMicrosoft');
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
  onContinue: (which: SignInProvider) => Promise<void>;
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
    : ['google.com', 'github.com', ...(microsoftSignInEnabled() ? ['microsoft.com'] : [])].filter((p) => p !== pendingLink.attemptedProvider);
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
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {choices.map((id) => {
        const which = id === 'google.com' ? 'google' : id === 'microsoft.com' ? 'microsoft' : 'github';
        // USERS-UX-17 — one shared `.signin-provider` register; the per-vendor
        // modifier classes this used to add were defined nowhere.
        return (
          <button
            key={id}
            className="signin-provider"
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

/** The sign-in modal: provider buttons + password card, or the account-link flow. */
export function SignInDialog(props: {
  pendingLink: PendingLink | null;
  busy: boolean;
  error: string | null;
  demo: boolean;
  /** The hard-sign-out reason key this instance is presenting, if any. */
  refusalReason: string | null;
  onAttempt: (which: SignInProvider) => Promise<void>;
  onAuthed: () => Promise<void>;
  onCancelLink: () => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('auth');
  const { pendingLink, busy, error, demo, refusalReason, onAttempt, onAuthed, onCancelLink, onClose } = props;
  const oidcButtons = (
    <div className="u-grid u-gap-1">
      <button className="signin-provider" disabled={busy} aria-busy={busy} type="button" onClick={() => { void onAttempt('google'); }}>
        <GoogleMark />
        {t('continueWithGoogle')}
      </button>
      <button className="signin-provider" disabled={busy} aria-busy={busy} type="button" onClick={() => { void onAttempt('github'); }}>
        <GithubMark />
        {t('continueWithGithub')}
      </button>
      {microsoftSignInEnabled() ? (
        <button className="signin-provider" disabled={busy} aria-busy={busy} type="button" onClick={() => { void onAttempt('microsoft'); }}>
          <MicrosoftMark />
          {t('continueWithMicrosoft')}
        </button>
      ) : null}
      {/* §11: surface a visible, announced "still signing in" status while the
       *  redirect round-trip is in flight (the page navigates away, then returns
       *  via processRedirectResult on the next load). */}
      <div className="signin-status muted" role="status" aria-live="polite">
        {busy ? t('signingInRedirect') : ''}
      </div>
    </div>
  );
  return (
    <Modal label={t('signIn')} onClose={onClose} className="signin-modal" scrimClassName="signin-modal-backdrop">
      {pendingLink ? (
        <LinkAccountBody pendingLink={pendingLink} busy={busy} error={error} onContinue={onAttempt} onCancel={onCancelLink} />
      ) : (
        <>
          <h3 className="signin-modal-title">
            <Trans t={t} i18nKey={demo ? 'signInToSaveTitle' : 'signInIdentityTitle'} components={{ 0: <em /> }} />
          </h3>
          <p className="signin-modal-lede muted">
            {t(demo ? 'signInToSaveLede' : 'signInIdentityLede')}
          </p>
          {refusalReason ? (
            <Notice variant="error" announce={t(`sessionRefused_${refusalReason}`)}>
              {t(`sessionRefused_${refusalReason}`)}
            </Notice>
          ) : null}
          {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
          <AuthCard oidc={oidcButtons} passwordEnabled={true} onAuthed={onAuthed} />
          <button className="signin-modal-cancel" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
        </>
      )}
    </Modal>
  );
}

/** Delete-account confirmation. Owns its own in-flight/error state: a fresh mount
 *  per open is the reset the parent used to do by hand. */
export function DeleteAccountDialog(props: { email: string; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('auth');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  return (
    <Modal
      label={t('confirmAccountDeletion')}
      onClose={() => { if (!deleting) props.onClose(); }}
      className="signin-modal"
      scrimClassName="signin-modal-backdrop"
    >
      <h3 className="signin-modal-title">{t('deleteAccountTitle')}</h3>
      <p>
        <Trans t={t} i18nKey="deleteAccountBody" values={{ email: props.email }} components={{ 0: <strong /> }} />
      </p>
      {deleteError ? <Notice variant="error" announce={deleteError}>{deleteError}</Notice> : null}
      <div className="button-row">
        <button type="button" className="signin-modal-cancel" disabled={deleting} onClick={props.onClose}>
          {t('cancel')}
        </button>
        {/* USERS-UX-17 — the destructive confirm reads as danger (the
            `.signin-danger` class it used to carry was never defined). */}
        <Button
          variant="danger"
          loading={deleting}
          onClick={async () => {
            setDeleting(true);
            setDeleteError(null);
            try {
              const result = await deleteAccount();
              console.warn('openwop: account deleted', result);
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
        </Button>
      </div>
    </Modal>
  );
}

export function A11yPrefsDialog(props: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation('auth');
  return (
    <Modal onClose={props.onClose} label={t('a11y:prefsTitle')} showClose>
      <A11yPrefsFields />
    </Modal>
  );
}

export function LanguageDialog(props: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation('auth');
  return (
    <Modal onClose={props.onClose} label={t('common:language')} showClose>
      <LanguageSwitcher />
    </Modal>
  );
}
