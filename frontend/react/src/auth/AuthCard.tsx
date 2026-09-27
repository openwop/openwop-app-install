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
import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { MailCheckIcon } from '../ui/icons/index.js';
import { Notice } from '../ui/Notice.js';
import { Trans, useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../ui/Field.js';
import { config } from '../client/config.js';
import { getCapabilities } from '../client/runsClient.js';
import {
  signInWithEmail,
  signUpWithEmail,
  sendPasswordReset,
  sendVerifyEmail,
  describeAuthError,
  MfaRequiredError,
  completeMfaSignIn,
  getPendingMfaHints,
  hasPendingMfaChallenge,
} from './firebase.js';
import { finalizeFirebaseSession } from './finalizeSession.js';

type View = 'signin' | 'signup' | 'forgot' | 'verify' | 'mfa';

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
  // ADR 0389 P1: an OAuth redirect-back that hit the second-factor challenge
  // stashed a resolver before this modal opened — boot straight into code entry.
  const [view, setView] = useState<View>(hasPendingMfaChallenge() ? 'mfa' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  // USERS-UX-1 — which enrolled authenticator the code belongs to. Only
  // meaningful when the challenge carries >1 TOTP hint; '' = the first hint.
  const [mfaFactorUid, setMfaFactorUid] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Show "Sign in with SSO" only when the host advertises real SAML (RFC 0050).
  const [samlEnabled, setSamlEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // `getCapabilities()` (client/runsClient.ts), NOT a raw fetch. This used to
    // hand-roll `fetch('/.well-known/openwop')` and so bypassed the shared
    // client's 300s cache, its in-flight dedupe and its clear()-race guard — a
    // second owner for a read that already had one. It also sits on the
    // ANONYMOUS sign-in path (rendered by SignInButton), so the duplicate cost
    // one uncached round-trip per visitor against the ADR 0640 read budget,
    // where the shared client usually answers from cache.
    //
    // `onAuthChange(clearCapabilitiesCache)` is already wired in runsClient, so
    // the advertisement cannot go stale across a sign-in — which is the only
    // identity transition this pre-auth surface sees.
    // `as Promise<…>` follows CapabilitiesPanel.tsx:150 — the SDK's `Capabilities`
    // type does not declare `auth`, and that is how this client's other
    // consumers narrow it.
    void (getCapabilities() as Promise<{ auth?: { profiles?: string[] } }>)
      .then((c) => {
        if (!cancelled) setSamlEnabled((c.auth?.profiles ?? []).includes('openwop-auth-saml'));
      })
      .catch(() => { /* no SSO — unchanged: a failed read shows no SSO button */ });
    return () => { cancelled = true; };
  }, []);

  const ssoLogin = () => {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${config.baseUrl}/host/openwop-app/auth/saml/sso/login?returnTo=${returnTo}`;
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(describeAuthError(e)); }
    finally { setBusy(false); }
  };

  const doSignin = () => run(async () => {
    try {
      await signInWithEmail(email, password);
    } catch (e) {
      // ADR 0389 P1: enrolled account — switch to code entry, don't fail.
      // F3: a NEW challenge means new hints — a stale uid from a previous
      // challenge would select nothing and fail with a false "no factor" error.
      if (e instanceof MfaRequiredError) { setView('mfa'); setMfaFactorUid(''); setNotice(null); return; }
      throw e;
    }
    await finalizeFirebaseSession();
    await onAuthed();
  });

  // ADR 0389 P1: finish an MFA-challenged sign-in (password OR OAuth redirect)
  // with the authenticator code, then run the same backend handshake.
  // USERS-UX-1: pass the chosen factor uid so a user with several enrolled
  // devices asserts the one they actually hold.
  const doMfa = () => run(async () => {
    await completeMfaSignIn(mfaCode.trim(), mfaFactorUid || undefined);
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
    else if (view === 'mfa') doMfa();
  };

  // ADR 0389 P1 — second-factor code entry. Rendered INDEPENDENT of
  // `passwordEnabled` (an OAuth-only deployment hits this via redirect-back too)
  // and without the provider buttons (the user is mid-challenge).
  if (view === 'mfa') {
    // USERS-UX-1 — when the account holds more than one enrolled authenticator,
    // let the user pick WHICH device their code comes from (the first-hint-only
    // assertion locked out anyone who lost device #1 but still holds #2).
    const mfaHints = getPendingMfaHints();
    return (
      <div className="u-grid u-gap-4">
        {error ? <Notice variant="error">{error}</Notice> : null}
        <form className="u-grid u-gap-4" onSubmit={submit}>
          <p className="muted">{t('mfaCodeRequired')}</p>
          {mfaHints.length > 1 ? (
            <SelectField
              label={t('mfaFactorLabel')}
              value={mfaFactorUid || mfaHints[0]!.uid}
              onChange={(e) => setMfaFactorUid(e.target.value)}
            >
              {mfaHints.map((h, i) => (
                <option key={h.uid} value={h.uid}>
                  {h.displayName ?? t('mfaFactorUnnamed', { index: i + 1 })}
                </option>
              ))}
            </SelectField>
          ) : null}
          <TextField
            label={t('mfaCodeLabel')}
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
          />
          {/* USERS-UX-6: `loading` keeps the accessible name (aria-busy +
              disabled) instead of renaming the control to a bare '…'. */}
          <Button variant="primary" type="submit" loading={busy}>
            {t('signIn')}
          </Button>
        </form>
        <div className="auth-switch muted">
          <Button variant="link" onClick={() => { setView('signin'); setError(null); setMfaCode(''); setMfaFactorUid(''); }}>
            {t('backToSignIn')}
          </Button>
        </div>
      </div>
    );
  }

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

          {/* USERS-UX-4: the shared <Notice> primitive, with an explicit
              `announce` — a hand-rolled region born WITH its text announces
              nothing (the live-region doctrine in Notice.tsx). */}
          {notice ? <Notice variant="info" announce={notice}>{notice}</Notice> : null}
          {error ? <Notice variant="error">{error}</Notice> : null}

          {view === 'verify' ? (
            // Post-signup: the account exists + is signed in, but unverified.
            <div className="auth-verify">
              <span className="auth-verify-mark" aria-hidden="true">
                <MailCheckIcon size={22} />
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
                <Button variant="primary" onClick={() => { void onAuthed(); }}>
                  {t('continue')}
                </Button>
                <Button variant="quiet" onClick={doResend} disabled={busy} aria-busy={busy || undefined}>
                  {busy ? t('common:saving') : t('resendVerificationEmail')}
                </Button>
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

                {/* USERS-UX-6: keep the accessible name while in flight —
                    `loading` sets aria-busy + disabled, label stays visible. */}
                <Button variant="primary" type="submit" loading={busy}>
                  {view === 'signin' ? t('signIn')
                    : view === 'signup' ? t('createAccount')
                    : t('sendResetLink')}
                </Button>
              </form>

              <div className="auth-switch muted">
                {view === 'signin' && (
                  <>
                    <Button variant="link" onClick={() => { setView('forgot'); setError(null); setNotice(null); }}>{t('forgotPassword')}</Button>
                    <span>{t('newHere')}</span>
                    <Button variant="link" onClick={() => { setView('signup'); setError(null); setNotice(null); }}>{t('createAnAccount')}</Button>
                  </>
                )}
                {view === 'signup' && (
                  <Button variant="link" onClick={() => { setView('signin'); setError(null); setNotice(null); }}>{t('alreadyHaveAccount')}</Button>
                )}
                {view === 'forgot' && (
                  <Button variant="link" onClick={() => { setView('signin'); setError(null); setNotice(null); }}>{t('backToSignIn')}</Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
