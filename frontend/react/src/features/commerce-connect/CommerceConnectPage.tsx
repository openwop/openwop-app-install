/**
 * Commerce Connect page (ADR 0385 Phase 1) — seller Express onboarding + account
 * state. Start/resume onboarding redirects to the Stripe-hosted account link
 * (demo mode shows the honest sentinel instead); returning from Stripe
 * (`?onboarding=return`) auto-syncs live state. The seller dashboard proper
 * (orders/payouts) arrives in Phase 3.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatNumber } from '../../i18n/format.js';
import { getSellerAccount, startOnboarding, syncSellerAccount, getSellerStats, type SellerAccount, type SellerStats } from './commerceConnectClient.js';
import { SellerListingsCard, ApprovalQueueCard } from './SellerListingsCard.js';
import { AdminConsoleCard } from './AdminConsoleCard.js';

const STATE_TONE: Record<string, string> = { enabled: 'completed', pending: 'running', restricted: 'waiting-approval', deauthorized: 'cancelled' };

export function CommerceConnectPage(): JSX.Element {
  const { t } = useTranslation('commerce-connect');
  const access = useFeatureAccess('commerce-connect');
  const [params, setParams] = useSearchParams();
  const [seller, setSeller] = useState<SellerAccount | null>(null);
  const [stats, setStats] = useState<SellerStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) { setLoading(false); return; }
    let live = true;
    const returning = params.get('onboarding') === 'return';
    const load = returning
      ? syncSellerAccount().catch(() => getSellerAccount())
      : getSellerAccount();
    void load.then(async (s) => {
      if (!live) return;
      setSeller(s);
      if (s?.onboardingState === 'enabled') {
        // Stats are a companion read: their failure must not blank the account
        // card, but silently omitting the sales block reads as "no sales".
        setStats(await getSellerStats().then((x) => { setStatsFailed(false); return x; }).catch(() => { setStatsFailed(true); return null; }));
      }
    }).catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); }).finally(() => {
      if (!live) return;
      setLoading(false);
      if (returning) setParams({}, { replace: true });
    });
    return () => { live = false; };
  }, [access.enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- params intentionally read once on entry

  const onboard = useCallback(async () => {
    setBusy(true);
    try {
      const started = await startOnboarding();
      if (started.mode === 'live' && /^https:\/\//.test(started.url)) { window.location.href = started.url; return; }
      setSeller(started.seller);
      toast.info(t('demoOnboarding'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }, [t]);

  const sync = useCallback(async () => {
    setBusy(true);
    try { setSeller(await syncSellerAccount()); toast.info(t('synced')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  }, [t]);

  if (access.loading || loading) {
    return <div className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><Skeleton /></div>;
  }
  if (!access.enabled) {
    return <section className="u-grid u-gap-4" data-walkthrough="commerce-connect.page"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;
  }

  if (!seller) {
    /**
     * MKT-UX-3 — THE OPERATOR CARDS MOUNT HERE TOO.
     *
     * `ApprovalQueueCard` and `AdminConsoleCard` used to render only PAST this
     * early return, so a host superadmin whose OWN tenant had never onboarded as
     * a Stripe Express seller saw nothing but "Become a seller" and had no path
     * to the pending-listing approval queue, the cross-tenant order list, the
     * refund action, the dispute ledger, or the realized platform loss. The
     * generic approvals inbox is not a fallback BY DESIGN: `host/reviewProjection.ts`
     * states outright that this kind is decided from the dedicated operator queue,
     * and `ApprovalsInbox` has no `commerce-listing-publish` branch.
     *
     * Stated plainly: on a host whose operator is not also a seller, EVERY
     * native-paid listing sat at "Awaiting approval" forever and every refund and
     * dispute was invisible. CLAUDE.md's "both paid listing lanes are
     * approval-gated" invariant held in the backend and was defeated in the shell.
     *
     * Mounting them here is safe because each card already treats the BACKEND as
     * the authority: both `load()`s hide on 401/403 (`ApiError.status`) and show a
     * designed retry on anything else. A non-superadmin sees what they saw before
     * — nothing.
     */
    const operatorCards = <><ApprovalQueueCard /><AdminConsoleCard /></>;
    // A FAILED account read must not render the onboarding start screen: that
    // invites an already-onboarded seller with a live Connect account to onboard
    // again. UX guard only — no change to the ADR 0176/0385 webhook routing,
    // fee math, or approval gates.
    if (loadError) {
      return (
        <section className="u-grid u-gap-4" data-walkthrough="commerce-connect.page">
          <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
          <StateCard announce
            title={t('accountLoadFailedTitle')}
            body={`${t('accountLoadFailedBody')} ${loadError}`}
            action={<Button variant="secondary" disabled={busy} onClick={sync}>{t('syncCta')}</Button>}
          />
          {operatorCards}
        </section>
      );
    }
    return (
      <section className="u-grid u-gap-4" data-walkthrough="commerce-connect.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard
          title={t('startTitle')}
          body={t('startBody')}
          action={<Button variant="primary" disabled={busy} onClick={onboard}>{busy ? t('starting') : t('startCta')}</Button>}
        />
        {operatorCards}
      </section>
    );
  }

  const canResume = seller.onboardingState === 'pending' || seller.onboardingState === 'restricted';
  return (
    <section className="u-grid u-gap-4" data-walkthrough="commerce-connect.page">
      <PageHeader
        eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={
          <div className="action-bar u-gap-2">
            {canResume ? <Button variant="primary" disabled={busy} onClick={onboard}>{busy ? t('starting') : t('resumeCta')}</Button> : null}
            <Button variant="secondary" disabled={busy} onClick={sync}>{t('syncCta')}</Button>
          </div>
        }
      />
      {seller.mode === 'demo' ? <Notice variant="info">{t('demoNotice')}</Notice> : null}
      {/* MKT-UX-13 — ANNOUNCED. `variant="warning"` is `role="status"`, which
          announces nothing on insertion, and this notice says the seller account
          was DISCONNECTED FROM THE PLATFORM — a money-state fact that silently
          changes what every control below can do. It cannot contend with
          `statsFailed` for the single polite slot: stats are fetched only when
          `onboardingState === 'enabled'`, so `statsFailed` is unreachable in the
          `deauthorized` branch. If that fetch condition is ever widened, this
          pairing must be revisited. */}
      {seller.onboardingState === 'deauthorized' ? <Notice variant="warning" announce={t('deauthorizedNotice')}>{t('deauthorizedNotice')}</Notice> : null}
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div className="action-bar u-justify-between u-items-center">
          <div>
            <div className="u-text-sm muted">{t('accountState')}</div>
            <strong>{t(`state_${seller.onboardingState}`)}</strong>
          </div>
          <StatusBadge status={STATE_TONE[seller.onboardingState] ?? 'paused'} label={t(`state_${seller.onboardingState}`)} />
        </div>
        <div className="u-grid u-gap-1">
          <div className="u-text-sm">
            <span className="muted">{t('charges')}</span>{' '}
            <strong>{seller.chargesEnabled ? t('yes') : t('no')}</strong>
            {' · '}
            <span className="muted">{t('payouts')}</span>{' '}
            <strong>{seller.payoutsEnabled ? t('yes') : t('no')}</strong>
            {seller.region ? <>{' · '}<span className="muted">{t('region')}</span> <strong>{seller.region}</strong></> : null}
          </div>
          <p className="u-m-0 u-text-sm muted">{t('webhookHint')}</p>
        </div>
      </div>
      {statsFailed ? <Notice variant="warning" announce={t('statsFailed')}>{t('statsFailed')}</Notice> : null}
      {stats ? (
        <>
          {/* MKT-UX-4 / MPL-9 — "Paid orders" and "Gross" used to include
              REFUNDED and DISPUTED orders at full amount, so a seller with two
              chargebacks read Paid 2 / Gross 80 and had no refund or dispute
              surface anywhere to correct it. Each state is now its own count and
              NET is the figure they actually kept. */}
          <div className="surface-card u-p-4 u-grid u-gap-3">
            <strong>{t('salesTitle')}</strong>
            <div className="u-text-sm">
              <span className="muted">{t('salesPaid')}</span>{' '}
              <strong>{formatNumber(stats.sales.paid)}</strong>
              {stats.sales.refunded > 0 ? <>{' · '}<span className="muted">{t('salesRefunded')}</span> <strong>{formatNumber(stats.sales.refunded)}</strong></> : null}
              {stats.sales.disputed > 0 ? <>{' · '}<span className="muted">{t('salesDisputed')}</span> <strong>{formatNumber(stats.sales.disputed)}</strong></> : null}
              {' · '}
              <span className="muted">{t('salesTotal')}</span>{' '}
              <strong>{formatNumber(stats.sales.total)}</strong>
            </div>
            {Object.keys(stats.sales.grossMajorUnitsByCurrency).length > 0 ? (
              <div className="u-text-sm">
                {Object.entries(stats.sales.grossMajorUnitsByCurrency).map(([cur, gross]) => (
                  <div key={cur}>
                    <span className="muted">{t('gross', { currency: cur.toUpperCase() })}</span>{' '}
                    <strong>{formatNumber(gross)}</strong>
                    {' · '}
                    <span className="muted">{t('platformFee')}</span>{' '}
                    <strong>{formatNumber(stats.sales.feesMajorUnitsByCurrency[cur] ?? 0)}</strong>
                    {(stats.sales.refundedMajorUnitsByCurrency[cur] ?? 0) > 0 ? (
                      <>
                        {' · '}
                        <span className="muted">{t('refundedLabel')}</span>{' '}
                        <strong>{formatNumber(stats.sales.refundedMajorUnitsByCurrency[cur] ?? 0)}</strong>
                        {' · '}
                        <span className="muted">{t('netLabel', { currency: cur.toUpperCase() })}</span>{' '}
                        <strong>{formatNumber(stats.sales.netMajorUnitsByCurrency[cur] ?? 0)}</strong>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              // MKT-UX-24(a) — "No sales yet" contradicted "All orders 3" sitting
              // directly above it whenever every order was still pending. Say
              // which of the two situations this actually is.
              <p className="u-m-0 u-text-sm muted">{stats.sales.total > 0 ? t('noSettledSalesYet') : t('noSalesYet')}</p>
            )}
          </div>
          <div className="surface-card u-p-4 u-grid u-gap-3">
            <strong>{t('payoutsTitle')}</strong>
            {stats.recentPayouts.length === 0 ? (
              <p className="u-m-0 u-text-sm muted">{t('noPayoutsYet')}</p>
            ) : (
              <ul className="u-m-0 u-p-0 u-list-none">
                {stats.recentPayouts.map((p) => (
                  <li key={p.payoutId} className="action-bar u-justify-between u-items-center u-text-sm">
                    <span>{formatNumber(p.amountMajorUnits)} {p.currency.toUpperCase()}</span>
                    <StatusBadge status={p.status === 'paid' ? 'completed' : 'failed'} label={t(`payout_${p.status}`)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
      {seller.onboardingState === 'enabled' ? <SellerListingsCard /> : null}
      <ApprovalQueueCard />
      <AdminConsoleCard />
    </section>
  );
}
