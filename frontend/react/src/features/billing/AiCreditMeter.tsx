/**
 * AI credit meter (ADR 0821 D1/D2/D4) — the billing page's view of the three
 * places a managed AI call is paid from, in the order they are drawn (free daily
 * allowance → the plan's monthly allowance → purchased credits), plus the
 * features that spent the most over the window.
 *
 * Lazy-loaded by `BillingPage` (its own chunk), and rendered only for a caller
 * who may manage billing: the read is `host:billing:manage` server-side.
 *
 * HONEST WHEN UNCONFIGURED: a leg the server returns as `null` (no free tier on
 * this host, no plan allowance) is not rendered at all — never a "0 of 0" bar that
 * would read as an exhausted allowance. Every figure is the server's, in credits;
 * the page never converts tokens itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { getAiCredits, type AiCreditMeter as Meter } from './billingClient.js';

const credits = (n: number): string => formatNumber(n, { maximumFractionDigits: 2 });

function MeterRow({ label, used, of, hint }: { label: string; used: number; of: number; hint: string }): JSX.Element {
  const { t } = useTranslation('billing');
  const text = t('creditsUsedOf', { used: credits(used), total: credits(of) });
  return (
    <div className="u-grid u-gap-1">
      <div className="action-bar u-justify-between u-items-center">
        <span className="u-text-sm">{label}</span>
        <span className="u-text-sm muted">{text}</span>
      </div>
      <progress className="credit-meter" max={of} value={Math.min(used, of)} aria-label={`${label}: ${text}`} />
      <span className="u-text-sm muted">{hint}</span>
    </div>
  );
}

export function AiCreditMeter(): JSX.Element {
  const { t } = useTranslation('billing');
  const [meter, setMeter] = useState<Meter | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    let live = true;
    setRetrying(true);
    void getAiCredits()
      .then((m) => { if (live) { setMeter(m); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e ?? new Error('ai credits read failed')); })
      .finally(() => { if (live) setRetrying(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => load(), [load]);

  if (error && !meter) {
    // A failed read says so — it never renders as "no credits".
    return (
      <Notice variant="warning" announce={t('creditsLoadFailed')}>
        {t('creditsLoadFailed')} {loadErrorMessage(t, error)}{' '}
        <Button variant="secondary" size="sm" disabled={retrying} aria-busy={retrying} onClick={() => { load(); }}>{t('retry')}</Button>
      </Notice>
    );
  }
  if (!meter) return <div className="surface-card u-p-4"><Skeleton /></div>;

  return (
    <section className="surface-card u-p-4 u-grid u-gap-3" aria-labelledby="billing-ai-credits-title">
      <div className="u-grid u-gap-1">
        <h2 id="billing-ai-credits-title" className="u-fs-16 u-m-0">{t('creditsTitle')}</h2>
        <p className="u-m-0 u-text-sm muted">{t('creditsIntro')}</p>
      </div>
      {meter.freeDaily ? (
        <MeterRow
          label={t('creditsFreeDaily')}
          used={meter.freeDaily.usedCredits}
          of={meter.freeDaily.capCredits}
          hint={meter.freeDaily.scope === 'subject' ? t('creditsFreeDailyHintSubject') : t('creditsFreeDailyHintTenant')}
        />
      ) : null}
      {meter.monthly ? (
        <MeterRow
          label={t('creditsMonthly')}
          used={meter.monthly.usedCredits}
          of={meter.monthly.allowanceCredits}
          hint={t('creditsMonthlyHint')}
        />
      ) : null}
      <div>
        <div className="u-text-sm muted">{t('creditsPurchased')}</div>
        <strong>{credits(meter.balanceCredits)}</strong> <span className="u-text-sm muted">{t('creditsPurchasedHint')}</span>
      </div>
      <div className="u-grid u-gap-2">
        <h3 className="u-text-sm u-m-0">{t('creditsTopFeatures', { days: meter.windowDays })}</h3>
        {meter.topFeatures.length === 0 ? (
          <p className="u-m-0 u-text-sm muted">{t('creditsTopFeaturesEmpty')}</p>
        ) : (
          <ul className="u-list-plain u-m-0 u-p-0 u-grid u-gap-1">
            {meter.topFeatures.map((f) => (
              <li key={f.featureId} className="action-bar u-justify-between u-items-center">
                <span className="u-text-sm">{f.label ?? f.featureId}</span>
                <span className="u-text-sm muted">
                  {t('creditsFeatureUsed', { used: credits(f.usedCredits) })}
                  {f.chargedCredits > 0 ? ` · ${t('creditsFeatureCharged', { charged: credits(f.chargedCredits) })}` : ''}
                </span>
              </li>
            ))}
            {meter.otherCredits > 0 ? (
              <li className="action-bar u-justify-between u-items-center">
                <span className="u-text-sm muted">{t('creditsOther')}</span>
                <span className="u-text-sm muted">{t('creditsFeatureUsed', { used: credits(meter.otherCredits) })}</span>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </section>
  );
}
