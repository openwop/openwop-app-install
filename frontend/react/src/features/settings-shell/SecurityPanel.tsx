/**
 * Security panel (ADR 0389 P1) — Firebase-delegated two-factor authentication.
 *
 * The host never sees factor material: enrollment is a client↔Identity-Platform
 * exchange (`TotpMultiFactorGenerator` via `auth/firebase.ts`); the backend only
 * reads the resulting `firebase.sign_in_second_factor` ID-token claim and marks
 * the session (`GET /users/me/security`). SSO-provisioned accounts (saml/scim)
 * manage MFA at their IdP — this panel says so instead of offering enrollment.
 *
 * QR: v1 ships the base32 secret + copy + `otpauth://` deep link (no QR-encoder
 * dependency — recorded in the ADR); authenticator apps accept manual entry.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDate } from '../../i18n/format.js';
import { useTranslation } from 'react-i18next';
import { Notice, StateCard } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { TextField } from '../../ui/Field.js';
import {
  getCurrentUser,
  listMfaFactors,
  startTotpEnrollment,
  completeTotpEnrollment,
  cancelTotpEnrollment,
  unenrollMfaFactor,
  describeAuthError,
  type MfaFactor,
} from '../../auth/firebase.js';
import { getMySecurity, reportFactorEvent, revokeMySessions, type MySecurity } from '../users/usersClient.js';
import { hardSignOut } from '../../auth/hardSignOut.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';

interface PendingEnroll { secretKey: string; otpauthUrl: string }

export function SecurityPanel(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  const [security, setSecurity] = useState<MySecurity | null>(null);
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** UX-SET-1 — a read failed, so we must NOT state this account's MFA posture. */
  const [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingEnroll | null>(null);
  const [code, setCode] = useState('');
  const firebaseUser = getCurrentUser();

  const refresh = useCallback(async (): Promise<void> => {
    // UX-SET-1 — on a SECURITY surface a swallowed read is not a cosmetic
    // problem: `getMySecurity()` → null renders the "Single-factor session"
    // chip, and `listMfaFactors()` → [] renders "No second factor enrolled
    // yet." Both are FACTUAL CLAIMS about the reader's MFA posture, and a
    // transient 5xx made the app assert them about an account that may have two
    // factors enrolled and a fully 2FA-verified session. It also suppresses the
    // accurate backup-factor guidance below (which keys off factors.length).
    // Erring toward "less secure than reality" is the safer direction, but it is
    // still false, and it drives real bad actions — re-enrolling, or tearing
    // down working factors to "fix" it.
    const [sec, f] = await Promise.allSettled([getMySecurity(), listMfaFactors()]);
    const secOk = sec.status === 'fulfilled';
    const facOk = f.status === 'fulfilled';
    setReadFailed(!secOk || !facOk);
    setSecurity(secOk ? sec.value : null);
    setFactors(facOk ? f.value : null);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoaded(true));
    // Drop an un-finalized enrollment secret when the panel unmounts.
    return () => cancelTotpEnrollment();
  }, [refresh]);

  const startEnroll = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      setPending(await startTotpEnrollment());
      setCode('');
    } catch (e) {
      // `auth/operation-not-allowed` = the Firebase project hasn't been upgraded
      // to Identity Platform with TOTP enabled — an operator task, say so.
      const codeStr = (e as { code?: string })?.code ?? '';
      setError(codeStr === 'auth/operation-not-allowed' ? t('mfaNotEnabledHint') : describeAuthError(e));
    } finally { setBusy(false); }
  };

  const finishEnroll = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await completeTotpEnrollment(code.trim(), t('mfaFactorDefaultName'));
      setPending(null);
      setCode('');
      toast.success(t('mfaEnrolled'));
      await refresh();
      // NIST 800-63B-4 §4.1.2.1 — notify the subscriber on every bind.
      void reportFactorEvent('bound', (factors?.length ?? 0) + 1);
    } catch (err) {
      setError(describeAuthError(err));
    } finally { setBusy(false); }
  };

  const cancelEnroll = (): void => {
    cancelTotpEnrollment();
    setPending(null);
    setCode('');
    setError(null);
  };

  const removeFactor = async (f: MfaFactor): Promise<void> => {
    // Removing the LAST factor is the lockout-adjacent action: Identity Platform
    // has no built-in second-factor recovery, so say so plainly rather than
    // reusing the generic confirm copy.
    const isLast = (factors?.length ?? 0) <= 1;
    const ok = await confirm({
      title: t('mfaRemoveTitle'),
      body: isLast ? t('mfaRemoveLastBody') : t('mfaRemoveBody'),
      confirmLabel: t('mfaRemoveConfirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await unenrollMfaFactor(f.uid);
      toast.success(t('mfaRemoved'));
      await refresh();
      void reportFactorEvent('unbound', Math.max(0, (factors?.length ?? 1) - 1));
    } catch (err) {
      setError(describeAuthError(err));
    } finally { setBusy(false); }
  };

  // ADR 0621 D5 / USERS-UX-11 — self-service "Sign out of all other devices".
  // The server bumps the caller's session epoch, which ends THIS session too
  // (its cookie is cleared on the response), so a success is itself a sign-out:
  // the confirm copy says so, and the same hard-sign-out path the mid-session
  // refusal takes runs right after.
  const [revoking, setRevoking] = useState(false);
  // Review NIT-3: `hardSignOut` tears this panel down (the sign-in modal takes
  // over), so the trailing state update must be guarded, and the modal's own
  // announced Notice IS the success announcement — a toast here made two.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const revokeAllSessions = async (): Promise<void> => {
    const ok = await confirm({
      title: t('signOutEverywhereTitle'),
      body: t('signOutEverywhereBody'),
      confirmLabel: t('signOutEverywhereConfirm'),
      danger: true,
    });
    if (!ok) return;
    setRevoking(true); setError(null);
    try {
      await revokeMySessions();
      await hardSignOut('self_revoked');
    } catch (err) {
      if (mountedRef.current) setError(loadErrorMessage(t, err));
    } finally { if (mountedRef.current) setRevoking(false); }
  };

  const copySecret = async (): Promise<void> => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.secretKey);
      toast.success(t('mfaSecretCopied'));
    } catch {
      setError(t('mfaSecretCopyFailed'));
    }
  };

  if (!loaded) return <StateCard loading title={t('loading')} />;

  const ssoManaged = security?.source === 'saml' || security?.source === 'scim';

  return (
    <div className="u-grid u-gap-3">
      <p>{t('securityHint')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="action-bar">
        <span className="muted">{t('signOutEverywhereHint')}</span>
        <Button variant="secondary" size="sm" loading={revoking} disabled={busy} onClick={() => void revokeAllSessions()}>
          {t('signOutEverywhere')}
        </Button>
      </div>

      {/* This session's posture — labeled chip, never color alone. Suppressed
          for IdP-provisioned accounts: their second factor happens at the IdP
          (SAML AuthnContext), which this Firebase-claim mark can't see — a
          "single-factor" chip there would be a false alarm. */}
      {/* UX-SET-1 — say the status is unknown; never assert it from a failed read. */}
      {readFailed ? (
        <Notice variant="warning" announce={t('securityReadFailed')}>
          {t('securityReadFailed')}{' '}
          <Button variant="quiet" size="sm" disabled={busy}
            onClick={() => { setReadFailed(false); void refresh(); }}>
            {t('common:retry')}
          </Button>
        </Notice>
      ) : null}

      {!ssoManaged && !readFailed ? (
        <div className="action-bar">
          <span className={`chip ${security?.mfaSessionVerified ? 'chip--success' : 'chip--muted'}`}>
            {security?.mfaSessionVerified ? t('mfaSessionOn') : t('mfaSessionOff')}
          </span>
        </div>
      ) : null}

      {ssoManaged ? (
        <Notice variant="info">{t('mfaSsoManaged')}</Notice>
      ) : !firebaseUser ? (
        <Notice variant="info">{t('mfaNeedsFirebaseSignIn')}</Notice>
      ) : (
        <>
          {factors === null ? (
            // UX-SET-1 — unknown, NOT "no second factor enrolled yet".
            <p className="muted">{t('mfaFactorsUnknown')}</p>
          ) : factors.length > 0 ? (
            <ul className="u-grid u-gap-2" aria-label={t('mfaFactorsLabel')}>
              {(factors ?? []).map((f) => (
                <li key={f.uid} className="action-bar">
                  <span>{f.displayName || t('mfaFactorDefaultName')}</span>
                  {f.enrolledAt ? (
                    <span className="muted" title={f.enrolledAt}>{formatDate(f.enrolledAt)}</span>
                  ) : null}
                  <Button variant="quiet" disabled={busy}
                    aria-label={`${t('mfaRemove')} — ${f.displayName || t('mfaFactorDefaultName')}`}
                    onClick={() => void removeFactor(f)}>
                    {t('mfaRemove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('mfaNoFactors')}</p>
          )}
          {/* ADR 0389 §3(a) promised "a second enrolled factor is the recovery
              path — surfaced in copy"; the § Correction makes it real. Identity
              Platform ships NO second-factor recovery, so a backup authenticator
              is the only self-service way out of a lost device. */}
          {/* `factors === null` = we don't know the count, so neither the
              "add a backup" prompt nor the "you're covered" reassurance may
              fire — the second would be an outright false assurance. */}
          {!pending && factors?.length === 1 ? (
            <Notice variant="warning">{t('mfaBackupPrompt')}</Notice>
          ) : null}
          {!pending && (factors?.length ?? 0) >= 2 ? (
            <p className="muted u-fs-12">{t('mfaBackupCovered')}</p>
          ) : null}

          {pending ? (
            <form className="u-grid u-gap-3" onSubmit={(e) => void finishEnroll(e)}>
              <p>{t('mfaEnrollStep1')}</p>
              <div className="action-bar">
                {/* Grouped for manual entry (authenticator apps ignore spaces);
                    the Copy button carries the RAW key. */}
                <code className="u-break-all">{pending.secretKey.replace(/(.{4})/g, '$1 ').trim()}</code>
                <Button variant="quiet" onClick={() => void copySecret()}>
                  {t('mfaCopySecret')}
                </Button>
                <a className="btn-ghost" href={pending.otpauthUrl}>{t('mfaOpenAuthenticator')}</a>
              </div>
              <TextField
                label={t('mfaVerifyCodeLabel')}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                help={t('mfaVerifyCodeHelp')}
              />
              <div className="action-bar">
                <Button variant="primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
                  {busy ? t('saving') : t('mfaConfirmEnroll')}
                </Button>
                <Button variant="quiet" onClick={cancelEnroll}>
                  {t('mfaCancelEnroll')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="action-bar">
              <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void startEnroll()}>
                {t('mfaAddFactor')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
