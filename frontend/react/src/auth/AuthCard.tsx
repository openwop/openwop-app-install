/**
 * AuthCard — the email/password auth surface, shown alongside the Firebase OIDC
 * buttons (Google/GitHub) + the enterprise SSO button in the sign-in modal.
 *
 * ADR 0026: email/password is **Firebase Authentication**, not a host credential
 * store. Sign-up / sign-in / password-reset all go through the Firebase SDK
 * (`auth/firebase.ts`); on success `finalizeFirebaseSession()` runs the same
 * backend handshake the OAuth flows use (`/migrate-tenant` + `/oidc/bind`), so a
 * Firebase email/password user becomes a durable `user:<userId>` exactly like a
 * Google user. There is no server-side password — Firebase mints the ID token the
 * host's OIDC bearer path already verifies.
 */
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { TextField } from '../ui/Field.js';
import { config, authedHeaders, fetchOpts } from '../client/config.js';
import {
  signInWithEmail,
  signUpWithEmail,
  sendPasswordReset,
  sendVerifyEmail,
  describeAuthError,
} from './firebase.js';
import { finalizeFirebaseSession } from './finalizeSession.js';

type View = 'signin' | 'signup' | 'forgot' | 'verify';

export function AuthCard({
  oidc,
  passwordEnabled,
  onAuthed,
}: {
  oidc?: React.ReactNode;
  passwordEnabled: boolean;
  onAuthed: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('auth');
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Show "Sign in with SSO" only when the host advertises real SAML (RFC 0050).
  const [samlEnabled, setSamlEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${config.baseUrl}/.well-known/openwop`, fetchOpts({ headers: authedHeaders() }))
      .then((r) => (r.ok ? r.json() : {}))
      .then((c: { auth?: { profiles?: string[] } }) => {
        if (!cancelled) setSamlEnabled((c.auth?.profiles ?? []).includes('openwop-auth-saml'));
      })
      .catch(() => { /* no SSO */ });
    return () => { cancelled = true; };
  }, []);

  const ssoLogin = () => {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${config.baseUrl}/v1/host/openwop-app/auth/saml/sso/login?returnTo=${returnTo}`;
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(describeAuthError(e)); }
    finally { setBusy(false); }
  };

  const doSignin = () => run(async () => {
    await signInWithEmail(email, password);
    await finalizeFirebaseSession();
    await onAuthed();
  });

  const doSignup = () => run(async () => {
    if (password !== confirm) { setError(t('passwordsDoNotMatch')); return; }
    await signUpWithEmail(email, password, displayName.trim() || undefined);
    // Firebase sends the verification email; the account is already signed in.
    // Land on the `verify` view (rather than closing) so the user sees the
    // "check your email" prompt + a resend, then continues into the app.
    await finalizeFirebaseSession();
    setNotice(null);
    setView('verify');
  });

  const doResend = () => run(async () => {
    await sendVerifyEmail();
    setNotice(t('verificationEmailSent'));
  });

  const doForgot = () => run(async () => {
    try {
      await sendPasswordReset(email);
    } catch (e) {
      // Don't leak whether the email exists — Firebase throws user-not-found for
      // an unknown address. Any other error still surfaces.
      if ((e as { code?: string })?.code !== 'auth/user-not-found') throw e;
    }
    setView('signin');
    setNotice(t('resetLinkOnItsWay'));
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (view === 'signin') doSignin();
    else if (view === 'signup') doSignup();
    else if (view === 'forgot') doForgot();
  };

  return (
    <div className="u-grid u-gap-4">
      {oidc}

      {samlEnabled ? (
        <button type="button" className="signin-provider" onClick={ssoLogin}>
          {t('signInWithSso')}
        </button>
      ) : null}

      {passwordEnabled && (
        <>
          {oidc ? <div className="auth-divider"><span>{t('or')}</span></div> : null}

          {notice ? <div className="alert info" role="status">{notice}</div> : null}
          {error ? <div className="alert error" role="alert">{error}</div> : null}

          {view === 'verify' ? (
            // Post-signup: the account exists + is signed in, but unverified.
            <div className="auth-verify">
              <span className="auth-verify-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7.5 12 13l9-5.5" />
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m8.5 13.5 2.2 2.2L16 11" />
                </svg>
              </span>
              <h4 className="auth-verify-title">{t('checkYourInbox')}</h4>
              <p className="auth-verify-body">
                <Trans
                  t={t}
                  i18nKey="verifyBody"
                  values={{ email }}
                  components={{ 0: <span className="auth-verify-email" /> }}
                />
              </p>
              <div className="auth-verify-actions">
                <button type="button" className="btn-primary" onClick={() => { void onAuthed(); }}>
                  {t('continue')}
                </button>
                <button type="button" className="btn-ghost" onClick={doResend} disabled={busy}>
                  {busy ? '…' : t('resendVerificationEmail')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <form className="u-grid u-gap-4" onSubmit={submit}>
                <TextField label={t('emailLabel')} type="email" autoComplete="email" required
                  value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('emailPlaceholder')} />

                {view === 'signup' && (
                  <TextField label={t('nameLabel')} autoComplete="name"
                    value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={t('namePlaceholder')} help={t('nameHelp')} />
                )}

                {(view === 'signin' || view === 'signup') && (
                  <TextField label={t('passwordLabel')} type="password" required
                    autoComplete={view === 'signin' ? 'current-password' : 'new-password'}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    help={view === 'signup' ? t('passwordHelp') : undefined} />
                )}

                {view === 'signup' && (
                  <TextField label={t('confirmPasswordLabel')} type="password" required autoComplete="new-password"
                    value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                )}

                <button className="btn-primary" type="submit" disabled={busy}>
                  {busy ? '…'
                    : view === 'signin' ? t('signIn')
                    : view === 'signup' ? t('createAccount')
                    : t('sendResetLink')}
                </button>
              </form>

              <div className="auth-switch muted">
                {view === 'signin' && (
                  <>
                    <button type="button" className="btn-link" onClick={() => { setView('forgot'); setError(null); setNotice(null); }}>{t('forgotPassword')}</button>
                    <span>{t('newHere')}</span>
                    <button type="button" className="btn-link" onClick={() => { setView('signup'); setError(null); setNotice(null); }}>{t('createAnAccount')}</button>
                  </>
                )}
                {view === 'signup' && (
                  <button type="button" className="btn-link" onClick={() => { setView('signin'); setError(null); setNotice(null); }}>{t('alreadyHaveAccount')}</button>
                )}
                {view === 'forgot' && (
                  <button type="button" className="btn-link" onClick={() => { setView('signin'); setError(null); setNotice(null); }}>{t('backToSignIn')}</button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
