/**
 * The re-authentication dialog `<ReauthRoot>` opens when Firebase refuses a
 * change with `auth/requires-recent-login` (`auth/reauth.ts`). It confirms the
 * CURRENT user with the method they signed in with — a provider popup, or their
 * password — finishes a second-factor challenge in place, and reports back so
 * the caller retries the change. A method it cannot confirm here (SSO, phone, an
 * unknown provider) gets the honest fallback: sign out and sign in again.
 *
 * Loaded on demand: it pulls in `auth/stepUp.ts`, which keeps the Firebase
 * re-authentication calls out of the entry chunk.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { Button } from '../ui/Button.js';
import { SelectField, TextField } from '../ui/Field.js';
import { GoogleMark } from '../brand/vendor/GoogleMark.js';
import { GithubMark } from '../brand/vendor/GithubMark.js';
import { MicrosoftMark } from '../brand/vendor/MicrosoftMark.js';
import {
  MfaRequiredError,
  clearPendingMfaChallenge,
  completeMfaSignIn,
  describeAuthError,
  getPendingMfaHints,
} from './firebase.js';
import {
  getReauthMethod,
  reauthenticateWithPassword,
  reauthenticateWithProviderPopup,
  type ReauthMethod,
} from './stepUp.js';
import { hardSignOut } from './hardSignOut.js';
import { logout } from '../features/users/usersClient.js';

type View = { kind: 'loading' } | ReauthMethod | { kind: 'mfa' };

/** Closing the provider popup is the person changing their mind, not an error. */
const QUIET_POPUP_CODES = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

export function ReauthDialog({ onDone }: { onDone: (ok: boolean) => void }): JSX.Element {
  const { t } = useTranslation('auth');
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorUid, setFactorUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the dialog has reported, so the unmount cleanup knows whether an
   *  MFA challenge was abandoned. */
  const finished = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getReauthMethod()
      .then((m) => { if (!cancelled) setView(m); })
      .catch(() => { if (!cancelled) setView({ kind: 'unsupported' }); });
    return () => {
      cancelled = true;
      // A challenge left behind would boot the next sign-in modal into code entry.
      if (!finished.current) clearPendingMfaChallenge();
    };
  }, []);

  const finish = (ok: boolean): void => {
    finished.current = true;
    if (!ok) clearPendingMfaChallenge();
    onDone(ok);
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await fn();
      finish(true);
    } catch (e) {
      if (e instanceof MfaRequiredError) { setView({ kind: 'mfa' }); setCode(''); setFactorUid(''); return; }
      const errCode = (e as { code?: string })?.code ?? '';
      if (QUIET_POPUP_CODES.has(errCode)) return;
      setError(errCode === 'auth/popup-blocked'
        ? t('popupBlocked', { domain: window.location.host })
        : describeAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const signOutAndBack = async (): Promise<void> => {
    setBusy(true);
    // Both sessions, as the account menu's sign-out does; `hardSignOut` then
    // opens the sign-in modal with a reason, so the person lands on sign-in.
    await logout();
    finish(false);
    await hardSignOut('session_revoked');
  };

  const close = (): void => { if (!busy) finish(false); };

  let body: JSX.Element;
  if (view.kind === 'loading') {
    body = <p className="muted" role="status">{t('reauthLoading')}</p>;
  } else if (view.kind === 'popup') {
    const mark = view.providerId === 'google.com' ? <GoogleMark />
      : view.providerId === 'github.com' ? <GithubMark /> : <MicrosoftMark />;
    const name = view.providerId === 'google.com' ? t('providerGoogle')
      : view.providerId === 'github.com' ? t('providerGithub') : t('providerMicrosoft');
    body = (
      <Button variant="secondary" loading={busy} onClick={() => void run(reauthenticateWithProviderPopup)}>
        {mark}
        {t('continueWith', { provider: name })}
      </Button>
    );
  } else if (view.kind === 'password') {
    body = (
      <form className="u-grid u-gap-4" onSubmit={(e) => { e.preventDefault(); void run(() => reauthenticateWithPassword(password)); }}>
        <TextField label={t('emailLabel')} type="email" autoComplete="username" readOnly value={view.email} />
        <TextField label={t('passwordLabel')} type="password" required autoFocus autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button variant="primary" type="submit" loading={busy}>{t('reauthConfirm')}</Button>
      </form>
    );
  } else if (view.kind === 'mfa') {
    const hints = getPendingMfaHints();
    body = (
      <form className="u-grid u-gap-4" onSubmit={(e) => { e.preventDefault(); void run(() => completeMfaSignIn(code.trim(), factorUid || undefined)); }}>
        <p className="muted">{t('reauthMfaLede')}</p>
        {hints.length > 1 ? (
          <SelectField label={t('mfaFactorLabel')} value={factorUid || hints[0]!.uid} onChange={(e) => setFactorUid(e.target.value)}>
            {hints.map((h, i) => (
              <option key={h.uid} value={h.uid}>{h.displayName ?? t('mfaFactorUnnamed', { index: i + 1 })}</option>
            ))}
          </SelectField>
        ) : null}
        <TextField label={t('mfaCodeLabel')} required autoFocus inputMode="numeric" autoComplete="one-time-code"
          placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
        <Button variant="primary" type="submit" loading={busy}>{t('reauthConfirm')}</Button>
      </form>
    );
  } else {
    body = (
      <div className="u-grid u-gap-4">
        <p>{t('reauthUnsupported')}</p>
        <Button variant="primary" loading={busy} onClick={() => void signOutAndBack()}>{t('reauthSignOutAgain')}</Button>
      </div>
    );
  }

  return (
    <Modal label={t('reauthTitle')} onClose={close} className="signin-modal" scrimClassName="signin-modal-backdrop">
      <h3 className="signin-modal-title">{t('reauthTitle')}</h3>
      {view.kind !== 'unsupported' ? <p className="signin-modal-lede muted">{t('reauthLede')}</p> : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {body}
      <Button variant="quiet" disabled={busy} onClick={() => finish(false)}>
        {t('cancel')}
      </Button>
    </Modal>
  );
}
