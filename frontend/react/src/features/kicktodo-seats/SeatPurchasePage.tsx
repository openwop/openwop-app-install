/**
 * Cohort seat purchase (ADR 0431 P4) — reached by a link the coach shares
 * (`/kicktodo/seats/:productId`), which is how coached cohorts actually sell;
 * no cohort marketplace is invented to justify a browse surface that has no
 * demand behind it yet.
 *
 * The honest states this page must never blur:
 *  - FULL is stated plainly, and the reserve action disappears;
 *  - a HELD seat shows the real remaining minutes, not a vague "reserved";
 *  - refund terms are disclosed BEFORE the reserve action, not after checkout.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { UsersIcon } from '../../ui/icons/index.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { getSeatAvailability, reserveSeat, type SeatAvailability } from '../../client/kicktodoSeatClient.js';
import { formatDate } from '../../i18n/format.js';

/** Whole minutes until `iso`, or null once it has passed. Exported for a unit
 *  test — the boundary (exactly-now → null, not 0) is the load-bearing part. */
export function minutesLeft(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  return ms > 0 ? Math.ceil(ms / 60000) : null;
}

export function SeatPurchasePage() {
  const { t } = useTranslation('kicktodo-seats');
  const { productId = '' } = useParams();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const [availability, setAvailability] = useState<SeatAvailability | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      setError(false);
      setAvailability(await getSeatAvailability(productId));
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Tick only while a hold is live, so the countdown stays truthful without
  // running a timer on a page that has nothing to count down.
  useEffect(() => {
    const expiresAt = availability?.holdExpiresAt;
    // KTUX-13 — do not arm (or keep) a timer for a hold that has already
    // lapsed. The deps only change when a NEW hold arrives, so without this the
    // interval kept firing every 30s forever after expiry.
    if (!expiresAt || Date.parse(expiresAt) <= Date.now()) return undefined;
    const id = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (Date.parse(expiresAt) <= n) window.clearInterval(id); // stop the moment it lapses
    }, 30_000);
    return () => window.clearInterval(id);
  }, [availability?.holdExpiresAt]);

  const onReserve = async () => {
    setBusy(true);
    try {
      const ok = await reserveSeat(productId);
      setFull(!ok);
      await reload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const remaining = minutesLeft(availability?.holdExpiresAt, now);

  return (
    <div className="page">
      <PageHeader title={t('title')} lede={t('lede')} />

      {error && <Notice variant="error">{t('loadError')}</Notice>}
      {!loaded && !error && <StateCard loading title={t('title')} />}

      {loaded && !error && !availability && (
        <StateCard icon={<UsersIcon aria-hidden />} title={t('notFoundTitle')} body={t('notFoundBody')} />
      )}

      {loaded && availability && (
        <section className="surface-card" aria-label={t('title')}>
          <h2>
            {availability.challengeId
              ? <Link className="title-link" to={`/discover/${encodeURIComponent(availability.challengeId)}`}>
                  {availability.challengeTitle || t('untitledChallenge')}
                </Link>
              : (availability.challengeTitle || t('untitledChallenge'))}
          </h2>
          <div className="action-bar">
            <span className="chip">{t('startsOn', { date: (() => { try { return formatDate(availability.startDateLocal, { dateStyle: 'medium' }); } catch { return availability.startDateLocal; } })() })}</span>
            {availability.seatsLeft > 0 ? (
              <span className="chip chip--success">{t('seatsLeft', { count: availability.seatsLeft })}</span>
            ) : (
              <span className="chip chip--muted">{t('cohortFull')}</span>
            )}
          </div>

          {availability.heldByYou && remaining === null && (
            <Notice variant="info">{t('holdExpired')}</Notice>
          )}
          {full && !availability.heldByYou && <Notice variant="info">{t('fullNotice')}</Notice>}

          {/* §5.10 — terms are read BEFORE reserving, never after the CTA. */}
          <Notice variant="info">
            <strong className="u-fs-13">{t('refundHeading')}</strong>
            <p className="u-fs-13">{t('refundTerms')}</p>
          </Notice>

          {/* The reserve → pay → confirm flow as three honest panels (ADR 0431 +
              one-pager pass). Each panel states only what the server backs: the
              hold shows the REAL remaining minutes as the serif figure; the
              confirm step is words, not a button — confirmation is the order-row
              CAS on verified payment, never a client action. */}
          <div className="kt-seatflow">
            <div className={availability.heldByYou && remaining !== null ? 'kt-seatflow__panel kt-seatflow__panel--held' : 'kt-seatflow__panel'}>
              <h3 className="kt-seatflow__step">{t('stepReserve')}</h3>
              {availability.heldByYou && remaining !== null ? (
                <>
                  <p className="muted u-fs-13">{t('heldForYou', { minutes: remaining })}</p>
                  <p className="kt-seatflow__timer" aria-hidden>
                    {remaining}<span className="kt-seatflow__timer-unit"> {t('holdMinutesUnit')}</span>
                  </p>
                </>
              ) : (
                <>
                  <p className="muted u-fs-13">{t('reservePanelBody')}</p>
                  {availability.seatsLeft > 0 && (
                    <Button variant="accent-solid" disabled={busy} aria-busy={busy} onClick={() => void onReserve()}>
                      {busy ? t('reserving') : t('reserveCta')}
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="kt-seatflow__panel">
              <h3 className="kt-seatflow__step">{t('stepPay')}</h3>
              <p className="muted u-fs-13">{availability.heldByYou && remaining !== null ? t('nextStep') : t('payPanelBody')}</p>
              {/* G4 — with a live hold, the buyer can actually pay: deep-link to the
                  product's public storefront (ADR 0455 P2 CTA pattern — the storefront
                  owns checkout; this page never touches money). Absent an orgId the
                  panel stays copy-only rather than offering a dead link. */}
              {availability.heldByYou && remaining !== null && availability.orgId && (
                <Link className="btn-accent-solid" to={`/store/${encodeURIComponent(availability.orgId)}`}>
                  {t('payCta')}
                </Link>
              )}
            </div>
            <div className="kt-seatflow__panel">
              <h3 className="kt-seatflow__step">{t('stepConfirm')}</h3>
              <p className="muted u-fs-13">{t('confirmPanelBody')}</p>
            </div>
          </div>

        </section>
      )}
    </div>
  );
}
