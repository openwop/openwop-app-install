/**
 * Billing page (ADR 0176) — plan / prepaid token balance / manage. Gated on
 * useFeatureAccess('billing'). Reads subscription + balance + entitlements; opens the
 * Stripe billing portal (demo sentinel until a Stripe key is configured).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { getSubscription, getBalance, openPortal, type Subscription, type TokenBalance } from './billingClient.js';

const PLAN_TONE: Record<string, string> = { active: 'completed', trialing: 'running', past_due: 'waiting-approval', canceled: 'cancelled', none: 'paused' };

export function BillingPage(): JSX.Element {
  const { t } = useTranslation('billing');
  const billing = useFeatureAccess('billing');
  const [sub, setSub] = useState<Subscription | null>(null);
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    let live = true;
    // `getSubscription`/`getBalance` are typed NON-nullable — they either resolve a
    // record or throw. So `sub === null` / `balance === null` below mean exactly
    // one thing: the read failed. The old `.catch(() => undefined)` left them null
    // and the render defaulted to `plan_free` / status `none` / balance `0`,
    // telling a PAYING customer they were on the Free plan with no tokens. Those
    // fallbacks were unreachable on success; they existed only to render a failure
    // as a money fact.
    void Promise.all([getSubscription(), getBalance()])
      .then(([s, b]) => { if (live) { setSub(s); setBalance(b); } })
      .catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!billing.enabled) { setLoading(false); return; }
    return load();
  }, [billing.enabled, load]);

  const manage = useCallback(async () => {
    setBusy(true);
    try {
      const { url, mode } = await openPortal();
      if (mode === 'live' && /^https:\/\//.test(url)) window.location.href = url;
      else toast.info(t('demoPortal'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }, [t]);

  if (billing.loading || loading) {
    return <div className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><Skeleton /></div>;
  }
  if (!billing.enabled) {
    return <section className="u-grid u-gap-4" data-walkthrough="billing.page"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="billing.page">
      <PageHeader
        eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={<Button variant="primary" disabled={busy} onClick={manage}>{busy ? t('opening') : t('manage')}</Button>}
      />
      {loadError ? (
        // No plan, no status, no balance — every one of those would be a claim
        // about money that this read did not establish. "Manage billing" stays
        // available in the header: the Stripe portal is the authoritative place
        // to check, which is exactly where someone seeing this should go.
        <StateCard announce
          title={t('loadFailedTitle')}
          body={`${t('loadFailedBody')} ${loadError}`}
          action={<Button variant="primary" onClick={load}>{t('retry')}</Button>}
        />
      ) : (
        <div className="surface-card u-p-4 u-grid u-gap-3">
          <div className="action-bar u-justify-between u-items-center">
            <div><div className="u-text-sm muted">{t('plan')}</div><strong>{t(`plan_${sub?.planTier ?? 'free'}`)}</strong></div>
            <StatusBadge status={PLAN_TONE[sub?.status ?? 'none'] ?? 'paused'} label={t(`status_${sub?.status ?? 'none'}`, { defaultValue: sub?.status ?? 'none' })} />
          </div>
          <div><div className="u-text-sm muted">{t('tokenBalance')}</div><strong>{formatNumber(balance?.totalAvailable ?? 0)}</strong> <span className="u-text-sm muted">{t('tokenBalanceHint')}</span></div>
          {sub?.currentPeriodEnd ? <p className="u-m-0 u-text-sm muted">{t('renews', { date: sub.currentPeriodEnd.slice(0, 10) })}</p> : null}
        </div>
      )}
    </section>
  );
}
