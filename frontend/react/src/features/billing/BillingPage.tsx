/**
 * Billing page (ADR 0176) — plan / prepaid token balance / manage, plus the ADR 0821
 * AI credit meter (lazy, admin-only). Gated on
 * useFeatureAccess('billing'). Reads subscription + balance + entitlements; opens the
 * Stripe billing portal (demo sentinel until a Stripe key is configured).
 */
import { Button } from '../../ui/Button.js';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../../i18n/format.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Notice } from '../../ui/Notice.js';
import { useScopeWriteAccess } from '../../lib/writeAccess.js';
import { useEffectiveAccessState } from '../../client/useEffectiveAccess.js';
import {
  getSubscription, getBalance, openPortal, billingErrorMessage, BILLING_MANAGE_SCOPE,
  type Subscription, type TokenBalance,
} from './billingClient.js';

// ADR 0821 — the AI credit meter is its own chunk: it is admin-only and the page
// renders it after the plan card, so it never weighs on the page's first paint.
const AiCreditMeter = lazy(() => import('./AiCreditMeter.js').then((m) => ({ default: m.AiCreditMeter })));
// Strategy §8 — the operator's cross-workspace paywall funnel: superadmin-only and
// its own chunk, so no other caller ever downloads it.
// ADR 0820 §7 — "Your data": the portability export list (admin/owner), own chunk.
const YourDataPanel = lazy(() => import('./YourDataPanel.js').then((m) => ({ default: m.YourDataPanel })));
const PaywallFunnelPanel = lazy(() => import('./PaywallFunnelPanel.js').then((m) => ({ default: m.PaywallFunnelPanel })));

// Every Stripe status the backend can store (ADR 0786 D2 widened the type):
// needing the customer's action → the attention tone; ended → cancelled.
const PLAN_TONE: Record<string, string> = {
  active: 'completed', trialing: 'running', past_due: 'waiting-approval', unpaid: 'waiting-approval',
  incomplete: 'waiting-approval', incomplete_expired: 'cancelled', canceled: 'cancelled', paused: 'paused', none: 'paused',
};
/** "Renews" is a claim only an entitled, still-billing subscription can make. */
const RENEWING = new Set(['active', 'trialing']);

export function BillingPage(): JSX.Element {
  const { t } = useTranslation('billing');
  const billing = useFeatureAccess('billing');
  const storeOn = useFeatureAccess('marketplace').enabled;
  const [sub, setSub] = useState<Subscription | null>(null);
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // ADR 0786 D5 — opening the portal (cancel, change card, read invoices) is an
  // admin act; the SERVER refuses anyone else with 403. The UI only stops offering a
  // button that would be refused. Fail-open while access loads (lib/writeAccess).
  const canManage = useScopeWriteAccess(BILLING_MANAGE_SCOPE);
  const superadmin = useEffectiveAccessState().access.superadmin === true;
  // Checkout return: the purchase is applied by Stripe's webhook, not by this
  // redirect, so say it is on its way rather than claiming it landed.
  const [params, setParams] = useSearchParams();
  const [returned, setReturned] = useState<'success' | 'cancelled' | null>(null);
  useEffect(() => {
    const outcome = params.get('checkout');
    if (outcome !== 'success' && outcome !== 'cancelled') return;
    setReturned(outcome);
    const next = new URLSearchParams(params); next.delete('checkout'); setParams(next, { replace: true });
  }, [params, setParams]);

  // `quiet` re-reads WITHOUT swapping the page for a skeleton — a refresh after a
  // checkout return must not unmount the notice (and the Refresh button holding
  // focus) it was pressed from.
  const load = useCallback((opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
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
      .catch((e: unknown) => { if (live) setLoadError(e ?? new Error('billing read failed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // After a success return, re-read once the webhook has had a moment (BILLUX-6);
  // the notice's Refresh covers a slower one.
  useEffect(() => {
    if (returned !== 'success' || !billing.enabled) return;
    const id = window.setTimeout(() => { load({ quiet: true }); }, 5000);
    return () => window.clearTimeout(id);
  }, [returned, billing.enabled, load]);
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
    } catch (e) { toast.error(billingErrorMessage(t, e)); } finally { setBusy(false); }
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
        actions={canManage || storeOn ? (
          <div className="action-bar">
            {/* The buyer's way into the Marketplace hub's primary tab (the store's own gate). */}
            {storeOn ? <Link className="btn secondary" to="/marketplace/bundles">{t('openStore')}</Link> : null}
            {canManage ? <Button variant="primary" disabled={busy} onClick={manage}>{busy ? t('opening') : t('manage')}</Button> : null}
          </div>
        ) : undefined}
      />
      {!canManage ? <p className="muted u-m-0">{t('manageAdminsOnly')}</p> : null}
      {returned === 'success' ? (
        <Notice variant="info" announce={t('checkoutProcessing')}>
          {t('checkoutProcessing')}{' '}
          <Button variant="secondary" size="sm" onClick={() => { load({ quiet: true }); }}>{t('refresh')}</Button>
        </Notice>
      ) : null}
      {returned === 'cancelled' ? <Notice variant="info" announce={t('checkoutCancelled')}>{t('checkoutCancelled')}</Notice> : null}
      {/* ADR 0820 §7 — dunning banner. Shown only on a SUCCESSFUL read that says
          past_due; the grace date is the server's (OPENWOP_BILLING_PAST_DUE_GRACE_DAYS),
          never computed here. Without a window, paid features are already paused. */}
      {!loadError && sub?.status === 'past_due' ? (
        <Notice variant="warning" announce={t('pastDueTitle')}>
          <strong>{t('pastDueTitle')}</strong>{' '}
          {sub.pastDueGraceEndsAt ? t('pastDueGrace', { date: formatDate(sub.pastDueGraceEndsAt) }) : t('pastDueNoGrace')}{' '}
          {canManage ? t('pastDueBody') : t('pastDueBodyMember')}
        </Notice>
      ) : null}
      {loadError ? (
        // No plan, no status, no balance — every one of those would be a claim
        // about money that this read did not establish. For someone who may open
        // it, "Manage billing" stays in the header (the Stripe portal is the
        // authoritative place to check); everyone else is told to ask an owner or
        // admin, never pointed at a button they are not shown (ADR 0786 / BILLUX-3).
        <StateCard announce
          title={t('loadFailedTitle')}
          // Localized classification, never raw transport text (BILLUX-9).
          body={`${canManage ? t('loadFailedBody') : t('loadFailedBodyMember')} ${loadErrorMessage(t, loadError)}`}
          action={<Button variant="primary" onClick={() => { load(); }}>{t('retry')}</Button>}
        />
      ) : (
        <div className="surface-card u-p-4 u-grid u-gap-3">
          <div className="action-bar u-justify-between u-items-center">
            <div><div className="u-text-sm muted">{t('plan')}</div><strong>{t(`plan_${sub?.planTier ?? 'free'}`)}</strong></div>
            <StatusBadge status={PLAN_TONE[sub?.status ?? 'none'] ?? 'paused'} label={t(`status_${sub?.status ?? 'none'}`, { defaultValue: sub?.status ?? 'none' })} />
          </div>
          <div><div className="u-text-sm muted">{t('tokenBalance')}</div><strong>{formatNumber(balance?.totalAvailable ?? 0)}</strong> <span className="u-text-sm muted">{t('tokenBalanceHint')}</span></div>
          {sub?.currentPeriodEnd && RENEWING.has(sub.status) ? (
            <p className="u-m-0 u-text-sm muted">
              {t(sub.cancelAtPeriodEnd ? 'accessUntil' : 'renews', { date: formatDate(sub.currentPeriodEnd) })}
            </p>
          ) : null}
        </div>
      )}
      {/* ADR 0821 — tenant-wide AI spend is admin-class (`host:billing:manage`
          server-side), so the meter is offered only to a caller who may manage
          billing; a member would get a refusal, not a meter. */}
      {!loadError && canManage ? (
        <Suspense fallback={<div className="surface-card u-p-4"><Skeleton /></div>}><AiCreditMeter /></Suspense>
      ) : null}
      {canManage ? (
        <Suspense fallback={<div className="surface-card u-p-4"><Skeleton /></div>}><YourDataPanel /></Suspense>
      ) : null}
      {superadmin ? (
        <Suspense fallback={<div className="surface-card u-p-4"><Skeleton /></div>}><PaywallFunnelPanel /></Suspense>
      ) : null}
    </section>
  );
}
