/**
 * ADR 0955 D7 — the org's sending health: the per-sender circuit breaker's state and its
 * trailing 7-day figures. A paused sender sends no marketing email until a manager reviews and
 * resumes it here (a person's act; the server refuses API keys and agents).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { Notice } from '../../ui/Notice.js';
import { formatNumber, formatPercent } from '../../i18n/format.js';
import { getSendingHealth, resumeSending, type SendingHealth } from './emailClient.js';

const pct = (part: number, whole: number): string => (whole > 0 ? formatPercent(part / whole, { maximumFractionDigits: 2 }) : '—');

export function EmailSendingHealthCard({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('email');
  const [health, setHealth] = useState<SendingHealth | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
  const activeOrg = useRef<string | null>(null);

  const load = useCallback(() => {
    if (activeOrg.current !== orgId) return;
    const seq = ++loadSeq.current;
    setFailed(false);
    getSendingHealth(orgId).then(
      (next) => { if (activeOrg.current === orgId && seq === loadSeq.current) setHealth(next); },
      () => { if (activeOrg.current === orgId && seq === loadSeq.current) setFailed(true); },
    );
  }, [orgId]);
  useEffect(() => {
    activeOrg.current = orgId;
    setHealth(null);
    setBusy(false);
    load();
    return () => { activeOrg.current = null; };
  }, [orgId, load]);

  const resume = async (): Promise<void> => {
    if (busy || activeOrg.current !== orgId) return;
    if (!(await confirm({ title: t('healthResumeConfirm'), body: t('healthResumeBody'), confirmLabel: t('healthResume') }))) return;
    if (activeOrg.current !== orgId) return;
    setBusy(true);
    try { await resumeSending(orgId); if (activeOrg.current === orgId) { toast.success(t('healthResumed')); load(); } }
    catch (e) { if (activeOrg.current === orgId) toast.error(e instanceof Error ? e.message : t('healthResumeFailed')); }
    finally { if (activeOrg.current === orgId) setBusy(false); }
  };

  const paused = health?.state?.paused === true;
  return (
    <section className="surface-card u-gap-2" aria-labelledby="email-health-heading">
      <h2 id="email-health-heading" className="u-fs-16 u-m-0">{t('healthHeading')}</h2>
      {failed ? (
        <Notice variant="error" announce={t('healthLoadFailed')}>
          {t('healthLoadFailed')} <Button variant="quiet" size="sm" onClick={load}>{t('healthRetry')}</Button>
        </Notice>
      ) : !health ? <p className="muted u-fs-13 u-m-0">{t('healthLoading')}</p> : (
        <>
          <p className="u-m-0 u-flex u-gap-2 u-items-center u-wrap">
            <span className={paused ? 'chip chip--danger' : 'chip chip--success'}>{paused ? t('healthPaused') : t('healthSending')}</span>
            <span className="muted u-fs-13">{paused
              ? (health.state?.reason === 'complaints' ? t('healthPausedComplaints') : t('healthPausedBounces'))
              : t('healthLede', { min: formatNumber(health.thresholds.minSends) })}</span>
          </p>
          <dl className="u-grid u-gap-1 u-m-0 u-fs-13">
            <div className="u-flex u-gap-2"><dt className="muted">{t('healthSent')}</dt><dd className="u-m-0">{formatNumber(health.window.sent)}</dd></div>
            <div className="u-flex u-gap-2"><dt className="muted">{t('healthBounceRate')}</dt><dd className="u-m-0">{pct(health.window.hardBounces, health.window.sent)} <span className="muted">({t('healthLimit', { limit: formatPercent(health.thresholds.hardBounceRate, { maximumFractionDigits: 1 }) })})</span></dd></div>
            <div className="u-flex u-gap-2"><dt className="muted">{t('healthComplaintRate')}</dt><dd className="u-m-0">{pct(health.window.complaints, health.window.sent)} <span className="muted">({t('healthLimit', { limit: formatPercent(health.thresholds.complaintRate, { maximumFractionDigits: 1 }) })})</span></dd></div>
          </dl>
          {health.warmup ? <p className="muted u-fs-12 u-m-0">{t('healthWarmup', { day: formatNumber(health.warmup.day), cap: formatNumber(health.warmup.cap), remaining: formatNumber(health.warmup.remaining) })}</p> : null}
          {paused ? (health.canResume
            ? <div><Button variant="primary" disabled={busy} onClick={() => void resume()}>{t('healthResume')}</Button></div>
            : <p className="muted u-fs-12 u-m-0">{t('healthResumeManagersOnly')}</p>) : null}
        </>
      )}
    </section>
  );
}
