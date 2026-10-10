/**
 * The feature store (ADR 0419 + ADR 0820 §5/§7 UI) — `/marketplace/bundles`.
 *
 * One page, one cadence: a page-level Monthly / Yearly switch drives every plan
 * and bundle price, and the other cadence is always shown underneath. Sections:
 *  - a status strip: the current plan, a bundles summary, and (admins only) the
 *    billing page's own lazily-loaded `AiCreditMeter` — never a second meter;
 *  - plans from the PUBLIC pricing read, with a "worth" line only when it can be
 *    computed honestly, and a plans × bundles comparison on the same page;
 *  - bundle cards grouped by the catalog's `group` DATA, filterable by status;
 *  - a deep-linkable detail panel (`?bundle=<id>`) with the full feature list,
 *    a computed plan upsell and a checkout summary;
 *  - an "AI credits" strip of the configured one-time credit packs (ADR 0821 D7,
 *    `CreditPacksStrip`), only when at least one pack is configured;
 *  - "always free" (the catalog's core) and a short FAQ that says only what the
 *    data supports.
 *
 * The white-label composer that used to live here is `/marketplace/distribution`
 * (`DistributionComposerPage`), reached through the Marketplace hub's tabs
 * (`MarketplaceHub`), which also own this page's H1 when it is embedded. Every figure is the operator's display copy or is
 * computed from it (`bundleStoreModel.ts`); nothing here invents a price, a
 * saving, a trial or a date.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { BoxesIcon, CheckIcon, LockIcon, SparklesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useHub } from '../../chrome/hubContext.js';
import { useScopeWriteAccess } from '../../lib/writeAccess.js';
import { ApiError } from '../../client/errorEnvelope.js';
import { useAuth } from '../../auth/useAuth.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { openHeaderSignIn, rememberReturn, takeReturn } from '../../auth/signInReturn.js';
import {
  fetchFeatureBundles, fetchBundleCommerce, fetchPublicPricing,
  type BundleCommerce, type FeatureBundleCatalog, type FeatureBundleInfo, type PublicPlanTier,
} from './marketplaceClient.js';
// ADR 0786 D5 — purchases are billing writes gated on `host:billing:manage`;
// billing's client carries the typed error, so a refusal reads as one.
import {
  buyBundle, buyCreditPack, buyPlan, getSubscription, billingErrorMessage, BILLING_MANAGE_SCOPE, type Subscription,
} from '../billing/billingClient.js';
import { CadenceSwitch } from './CadenceSwitch.js';
import { BundleDetailPanel } from './BundleDetailPanel.js';
import { BundleCompareTable } from './BundleCompareTable.js';
import { CreditPacksStrip } from './CreditPacksStrip.js';
import {
  bundlePrice, bundleStatus, canPurchase, formatLike, groupBundles, planCovers, planPrice, planWorth, readCadence,
  requiredBundles, writeCadence, type BundleStatus, type Cadence, type PriceView,
} from './bundleStoreModel.js';

// ADR 0821 — the billing page's AI credit meter, reused as-is in its own chunk.
const AiCreditMeter = lazy(() => import('../billing/AiCreditMeter.js').then((m) => ({ default: m.AiCreditMeter })));

type Filter = 'all' | BundleStatus;
const TOP_FEATURES = 3;
const STATUS_CHIP: Record<BundleStatus, string> = {
  owned: 'chip chip--success', included: 'chip chip--success', free: 'chip chip--accent', available: 'chip chip--muted',
};

/** The secondary price line: "or $290/yr · save $58" (monthly view) or
 *  "Save $58 a year vs monthly" (yearly view). Empty when nothing real to say. */
function OtherCadenceLine({ view, cadence }: { view: PriceView; cadence: Cadence }): JSX.Element | null {
  const { t } = useTranslation('marketplace');
  if (cadence === 'year' && view.price) {
    if (view.saving) return <span className="u-text-sm muted">{t('storeSaveYearly', { amount: view.saving.amount })}</span>;
    return view.otherPrice ? <span className="u-text-sm muted">{t('storeOr', { price: `${view.otherPrice}${view.otherCadence ?? ''}` })}</span> : null;
  }
  if (!view.otherPrice) return null;
  const other = `${view.otherPrice}${view.otherCadence ?? ''}`;
  return (
    <span className="u-text-sm muted">
      {view.saving ? t('storeOrSave', { price: other, amount: view.saving.amount }) : t('storeOr', { price: other })}
    </span>
  );
}

export function BundleShopPage(): JSX.Element {
  // `billing` too: a refused purchase is explained with billing's copy
  // (`billingErrorMessage`), and a lazily-loaded namespace is only fetched when a
  // component asks for it (ADR 0490).
  const { t } = useTranslation(['marketplace', 'billing']);
  const { embedded } = useHub();
  const access = useFeatureAccess('marketplace');
  const billing = useFeatureAccess('billing');
  // The server refuses a non-admin with 403 regardless; this only stops OFFERING a
  // money button that would be refused (fail-open while access loads).
  const canBuy = useScopeWriteAccess(BILLING_MANAGE_SCOPE);
  const [catalog, setCatalog] = useState<FeatureBundleCatalog | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  // ADR 0820 §7 — a signed-out visitor who opens the store directly: the catalog
  // read answers 401 `sign_in_required` (`resolveCallerUser`), which is NOT a
  // failure to retry but a sign-in to offer. Set only on that explicit 401.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const { user } = useAuth();
  const backendUser = useBackendSession().user;
  const signedIn = Boolean(user || backendUser);
  const navigate = useNavigate();
  const location = useLocation();
  const [commerce, setCommerce] = useState<BundleCommerce[] | null>(null);
  const [commerceUnavailable, setCommerceUnavailable] = useState(false);
  const [plans, setPlans] = useState<PublicPlanTier[]>([]);
  const [plansFailed, setPlansFailed] = useState(false);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [subFailed, setSubFailed] = useState(false);
  /** MKT-UX-8 — one checkout in flight at a time (a click during the round trip
   *  must not open a second session). Holds the bundle id or `plan:<tier>`. */
  const [buying, setBuying] = useState<string | null>(null);
  const [cadence, setCadenceState] = useState<Cadence>(readCadence);
  const [filter, setFilter] = useState<Filter>('all');
  const [params, setParams] = useSearchParams();
  const openId = params.get('bundle');
  const compareOpen = params.get('view') === 'compare';

  const setCadence = useCallback((c: Cadence) => { setCadenceState(c); writeCadence(c); }, []);

  const loadCatalog = useCallback(() => {
    setCatalog(null);
    setCatalogFailed(false);
    setNeedsSignIn(false);
    void fetchFeatureBundles().then(setCatalog).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setNeedsSignIn(true);
      else setCatalogFailed(true);
    });
  }, []);
  // `signedIn` is a dependency on purpose: an in-page sign-in (password) re-reads
  // the store instead of leaving the sign-in card up.
  useEffect(() => {
    if (!access.enabled) return;
    loadCatalog();
  }, [access.enabled, loadCatalog, signedIn]);
  // Back from sign-in (an OIDC redirect may land elsewhere in the app first, or
  // here): continue to the exact store URL — same query — the visitor left.
  useEffect(() => {
    if (!signedIn) return;
    const url = takeReturn();
    if (url && url !== `${location.pathname}${location.search}`) navigate(url);
  }, [signedIn, navigate, location.pathname, location.search]);
  const signIn = useCallback(() => {
    rememberReturn(`${location.pathname}${location.search}`);
    // No sign-in UI on this host (auth unconfigured): nothing to return from.
    if (!openHeaderSignIn()) takeReturn();
  }, [location.pathname, location.search]);

  // The billing-owned commerce projection. `[]` when billing is off (the route
  // 404s → the client returns []). A THROWN failure is different (MKT-G1): folding
  // it into [] would render a transient error as "nothing for sale".
  const loadCommerce = useCallback(() => {
    if (!access.enabled || !billing.enabled) { setCommerce([]); return; }
    setCommerceUnavailable(false);
    void fetchBundleCommerce().then(setCommerce).catch(() => { setCommerce([]); setCommerceUnavailable(true); });
  }, [access.enabled, billing.enabled]);
  useEffect(() => { loadCommerce(); }, [loadCommerce, signedIn]); // signedIn: re-read after a sign-in

  // Plans (public, works with billing off) + the workspace's own subscription.
  const loadPlans = useCallback(() => {
    if (!access.enabled || !billing.enabled) return;
    setPlansFailed(false);
    void fetchPublicPricing().then(setPlans).catch(() => { setPlans([]); setPlansFailed(true); });
    setSubFailed(false);
    void getSubscription().then(setSub).catch(() => { setSub(null); setSubFailed(true); });
  }, [access.enabled, billing.enabled]);
  useEffect(() => { loadPlans(); }, [loadPlans, signedIn]); // signedIn: re-read after a sign-in

  // Checkout return — the entitlement flips only when Stripe's webhook lands, so
  // never mark "owned" optimistically: toast honestly and re-read the grant.
  useEffect(() => {
    const outcome = params.get('checkout');
    if (!outcome) return;
    if (outcome === 'success') { toast.success(t('bundleCheckoutSuccess')); loadCommerce(); }
    // ADR 0821 D7 — a credit pack's return: the balance grows when the webhook lands.
    else if (outcome === 'credits') { toast.success(t('storeCreditsCheckoutSuccess')); }
    else if (outcome === 'cancelled') { toast.info(t('bundleCheckoutCancelled')); }
    const next = new URLSearchParams(params); next.delete('checkout'); setParams(next, { replace: true });
  }, [params, setParams, loadCommerce, t]);

  const setParam = useCallback((key: string, value: string | null, replace = false) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key); else next.set(key, value);
    setParams(next, { replace });
  }, [params, setParams]);

  // ADR 0419 §8 follow-on — a locked nav item links here as `?feature=<id>` (the
  // entry-chunk Sidebar spends no bytes looking the bundle up). Resolve it from the
  // catalog DATA to the bundle that sells it and open that drawer; a feature no
  // bundle sells just lands on the store. Replace, so Back skips the hop.
  const featureParam = params.get('feature');
  useEffect(() => {
    if (!featureParam || !catalog) return;
    const owner = catalog.bundles.find((b) => b.features.some((f) => f.id === featureParam));
    const next = new URLSearchParams(params);
    next.delete('feature');
    if (owner) next.set('bundle', owner.id);
    setParams(next, { replace: true });
  }, [featureParam, catalog, params, setParams]);

  const bundles = useMemo(() => catalog?.bundles ?? [], [catalog]);
  const commerceById = useMemo(() => new Map((commerce ?? []).map((c) => [c.bundleId, c])), [commerce]);

  const checkout = async (key: string, run: () => Promise<{ url: string; mode: 'live' | 'demo' }>): Promise<void> => {
    if (buying) return;
    setBuying(key);
    try {
      const { url, mode } = await run();
      // MKT-UX-9 — branch on `mode` ALONE: a live session with an unusable url must
      // never be told "no real charge was made".
      if (mode === 'live') {
        if (url) { window.location.assign(url); return; }
        toast.error(t('bundleCheckoutUnavailable'));
        return;
      }
      toast.info(t('bundleBuyDemo'));
    } catch (e) {
      toast.error(billingErrorMessage(t, e));
    } finally {
      setBuying(null);
    }
  };
  const buy = (bundleId: string, c: Cadence): void => { void checkout(bundleId, () => buyBundle(bundleId, c)); };
  const subscribe = (tier: 'pro' | 'team', c: Cadence): void => { void checkout(`plan:${tier}`, () => buyPlan(tier, c)); };
  const buyPack = (packKey: string): void => { void checkout(`pack:${packKey}`, () => buyCreditPack(packKey)); };

  // Inside the Marketplace hub the hub owns the H1 + lede, so the page drops its
  // header and keeps only its actions (the cadence switch) at the top of the pane.
  const header = (actions?: JSX.Element) => (embedded
    ? (actions ? <div className="action-bar u-justify-end">{actions}</div> : null)
    : <PageHeader eyebrow={t('storeEyebrow')} title={t('storeHeroTitle')} lede={t('storeHeroLede')} {...(actions ? { actions } : {})} />
  );

  if (access.loading) {
    return (
      <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="marketplace-bundles.page">
        {header()}
        <Skeleton />
      </div>
    );
  }
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  // The store universe: what is sold, owned or plan-included. With billing off
  // there is no commerce, so the catalog is listed without prices or statuses.
  const priced = billing.enabled && commerce !== null;
  const storeBundles = billing.enabled
    ? bundles.filter((b) => { const c = commerceById.get(b.id); return !!(c?.forSale || c?.owned || c?.includedInPlan); })
    : bundles;
  const counts: Record<Filter, number> = { all: storeBundles.length, available: 0, free: 0, owned: 0, included: 0 };
  for (const b of storeBundles) counts[bundleStatus(commerceById.get(b.id))]++;
  const shown = filter === 'all' ? storeBundles : storeBundles.filter((b) => bundleStatus(commerceById.get(b.id)) === filter);
  const groups = catalog ? groupBundles(catalog, shown) : [];
  const anyYearly = storeBundles.some((b) => bundlePrice(commerceById.get(b.id), 'year').sellsChosen)
    || plans.some((p) => !!p.display?.priceAnnual);
  const currentTier = sub ? sub.planTier : null;
  const currentPlan = plans.find((p) => p.tier === currentTier) ?? null;
  const openBundle = openId ? bundles.find((b) => b.id === openId) ?? null : null;
  const maxTrial = Math.max(0, ...storeBundles.map((b) => commerceById.get(b.id)?.trialDays ?? 0));
  const coreLabels = (catalog?.core ?? []).filter((f) => f.registered).map((f) => f.label ?? f.id);
  const showPlans = billing.enabled && plans.length > 0;

  const cadenceSwitch = priced && anyYearly ? (
    <div className="u-grid u-gap-1 fstore-cadence-wrap">
      <span id="store-cadence-label" className="u-text-sm muted">{t('storeCadenceLabel')}</span>
      <CadenceSwitch value={cadence} onChange={setCadence} labelledBy="store-cadence-label" />
    </div>
  ) : undefined;

  const filterLabel: Record<Filter, string> = {
    all: t('storeFilterAll'), available: t('storeFilterAvailable'), free: t('storeFilterFree'),
    owned: t('storeFilterOwned'), included: t('storeFilterIncluded'),
  };
  const statusLabel: Record<BundleStatus, string> = {
    owned: t('owned'), included: t('includedInPlan'), free: t('storeStatusFree'), available: t('storeStatusAvailable'),
  };

  const renderBundle = (b: FeatureBundleInfo): JSX.Element => {
    const c = commerceById.get(b.id);
    const status = bundleStatus(c);
    const chosen = bundlePrice(c, cadence);
    // A bundle not sold at the chosen cadence is offered at the one it IS sold at,
    // and its button says so — the cadence is never silently swapped.
    const effective: Cadence = chosen.sellsChosen ? cadence : cadence === 'year' ? 'month' : 'year';
    const view = chosen.sellsChosen ? chosen : bundlePrice(c, effective);
    const price = view.price ? `${view.price}${view.cadence ?? ''}` : null;
    const requires = requiredBundles(b, bundles);
    const more = b.features.length - TOP_FEATURES;
    // Buy only where checkout will succeed (server `purchasable`): a complimentary
    // bundle is "Free for now" with a note instead of a button that would 409.
    const buyable = priced && canPurchase(c) && (status === 'available' || status === 'free');
    const complimentary = priced && status === 'free' && !canPurchase(c);
    const titleId = `store-bundle-${b.id}`;
    return (
      <article key={b.id} className="surface-card fstore-card" aria-labelledby={titleId}>
        <div className="u-flex u-items-start u-justify-between u-gap-2">
          <div className="u-grid u-gap-0-5 u-min-w-0">
            <h4 id={titleId} className="u-m-0 u-fs-16">{b.label}</h4>
            {c?.priceDisplay?.blurb ? <span className="u-text-sm muted">{c.priceDisplay.blurb}</span> : null}
          </div>
          {priced ? (
            <span className={STATUS_CHIP[status]}>
              {status === 'owned' || status === 'included' ? <CheckIcon aria-hidden size={12} /> : null}{statusLabel[status]}
            </span>
          ) : null}
        </div>
        <ul className="fstore-card__features">
          {b.features.slice(0, TOP_FEATURES).map((f) => <li key={f.id}>{f.label ?? f.id}</li>)}
        </ul>
        <Button variant="link" className="fstore-card__more" onClick={() => setParam('bundle', b.id)} aria-label={t('storeDetailsAria', { bundle: b.label })}>
          {more > 0 ? t('storeMoreFeatures', { count: more }) : t('storeDetails')}
        </Button>
        {requires.length ? <span className="u-text-sm muted">{t('storeRequires', { bundles: requires.map((r) => r.label).join(', ') })}</span> : null}
        {priced ? (
          <div className="fstore-card__foot">
            <div className="u-grid u-gap-0-5">
              {price ? <span><strong className="fstore-price">{view.price}</strong><span className="muted">{view.cadence}</span></span> : null}
              <OtherCadenceLine view={view} cadence={effective} />
              {effective !== cadence && price ? <span className="u-text-sm muted">{t(effective === 'month' ? 'storeOnlyMonthly' : 'storeOnlyYearly')}</span> : null}
              {buyable && !price ? <span className="u-text-sm muted">{t('bundlePriceUnavailable')}</span> : null}
              {complimentary ? <span className="u-text-sm muted">{t('storeComplimentaryNote')}</span> : null}
            </div>
            {status === 'owned' ? (
              canBuy ? <Link className="btn-ghost btn-sm" to="/billing">{t('manageInPortal')}</Link> : null
            ) : buyable && canBuy ? (
              <Button
                variant="primary"
                disabled={buying !== null || !price}
                onClick={() => buy(b.id, effective)}
                aria-label={price
                  ? t(effective === 'year' ? 'buyYearlyAria' : 'buyMonthlyAria', { bundle: b.label, price })
                  : t('buyAria', { bundle: b.label })}
              >
                {buying === b.id ? t('buying') : price
                  ? t(effective === 'year' ? 'buyYearly' : 'buyMonthly', { price: view.price, cadence: view.cadence ?? '' }).trim()
                  : t('buy')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  };

  const renderPlan = (p: PublicPlanTier): JSX.Element => {
    const view = planPrice(p, cadence);
    const isCurrent = p.tier === currentTier;
    const worth = planWorth(p, bundles, commerceById);
    // Always the MONTHLY sum of the covered bundles' published prices — never a
    // derived yearly figure the operator did not publish.
    const worthAmount = worth ? formatLike(worth.template, worth.amount) : null;
    // Free's list of PRICED bundles is complimentary, not what the plan includes.
    const covered = p.features === '*' ? null
      : storeBundles.filter((b) => planCovers(p, b) && !(p.tier === 'free' && commerceById.get(b.id)?.forSale));
    const price = view.price ? `${view.price}${view.cadence ?? ''}` : null;
    const paidCurrent = currentTier !== null && currentTier !== 'free';
    const titleId = `store-plan-${p.tier}`;
    return (
      <article key={p.tier} className={`surface-card fstore-card${p.display?.highlighted ? ' fstore-card--featured' : ''}`} aria-labelledby={titleId}>
        <div className="u-flex u-items-center u-justify-between u-gap-2">
          <h3 id={titleId} className="u-m-0 u-fs-16">{p.name}</h3>
          {isCurrent ? <span className="chip chip--success">{t('storeCurrentPlan')}</span>
            : p.display?.highlighted ? <span className="chip chip--accent">{t('storePopular')}</span> : null}
        </div>
        <div className="u-grid u-gap-0-5">
          {price ? <span><strong className="fstore-price">{view.price}</strong><span className="muted">{view.cadence}</span></span>
            : p.tier === 'enterprise' ? <strong className="fstore-price">{t('storeCustomPrice')}</strong> : null}
          {price ? <OtherCadenceLine view={view} cadence={cadence} /> : null}
          {worthAmount ? (
            <span className="u-text-sm">{t('storeWorthMonthly', { amount: worthAmount })}</span>
          ) : null}
        </div>
        {p.display?.blurb ? <p className="u-m-0 u-text-sm muted">{p.display.blurb}</p> : null}
        {p.features === '*' ? (
          <p className="u-m-0 u-text-sm">{t('storePlanEverything')}</p>
        ) : covered && covered.length ? (
          <p className="u-m-0 u-text-sm">{t('storePlanBundles', { bundles: covered.map((b) => b.label).join(', ') })}</p>
        ) : null}
        <div className="fstore-card__foot">
          {isCurrent ? null : p.tier === 'enterprise' ? (
            <span className="u-text-sm muted">{t('storeEnterpriseContact')}</span>
          ) : p.tier === 'free' ? null : !canBuy ? null : paidCurrent ? (
            <Link className="btn-ghost btn-sm" to="/billing">{t('storeChangePlan')}</Link>
          ) : view.sellsChosen && price ? (
            <Button
              variant={p.display?.highlighted ? 'primary' : 'secondary'}
              disabled={buying !== null}
              onClick={() => subscribe(p.tier as 'pro' | 'team', cadence)}
              aria-label={t(cadence === 'year' ? 'storePlanYearlyAria' : 'storePlanMonthlyAria', { plan: p.name, price })}
            >
              {buying === `plan:${p.tier}` ? t('buying') : t(cadence === 'year' ? 'storePlanYearly' : 'storePlanMonthly', { plan: p.name, price })}
            </Button>
          ) : (
            <span className="u-text-sm muted">{t('storePlanNotSold')}</span>
          )}
        </div>
      </article>
    );
  };

  if (needsSignIn) {
    // The plan/commerce reads 401 too; their "unavailable" notices would read as
    // an outage, so the signed-out state is the sign-in card alone.
    return (
      <div className="u-gap-4 u-flex u-flex-col" data-walkthrough="marketplace-bundles.page">
        {header()}
        <StateCard
          announce
          icon={<LockIcon />}
          title={t('storeSignInTitle')}
          body={t('storeSignInBody')}
          action={<Button variant="primary" aria-haspopup="dialog" onClick={signIn}>{t('storeSignInAction')}</Button>}
        />
      </div>
    );
  }

  return (
    <div className="u-gap-4 u-flex u-flex-col" data-walkthrough="marketplace-bundles.page">
      {header(cadenceSwitch)}
      {commerceUnavailable ? (
        <Notice variant="warning" announce={t('commerceUnavailable')}>
          {t('commerceUnavailable')}{' '}
          <Button variant="secondary" size="sm" onClick={loadCommerce}>{t('common:retry')}</Button>
        </Notice>
      ) : null}
      {plansFailed ? (
        <Notice variant="warning" announce={t('storePlansFailed')}>
          {t('storePlansFailed')}{' '}
          <Button variant="secondary" size="sm" onClick={loadPlans}>{t('common:retry')}</Button>
        </Notice>
      ) : null}

      {catalogFailed ? (
        <StateCard
          announce
          icon={<BoxesIcon />}
          title={t('bundlesFailedTitle')}
          body={t('bundlesFailedBody')}
          action={<Button variant="secondary" onClick={loadCatalog}>{t('common:retry')}</Button>}
        />
      ) : !catalog || (billing.enabled && commerce === null) ? (
        <div className="u-grid u-gap-3" aria-busy="true">
          <Skeleton height={72} />
          <div className="card-grid"><Skeleton height={180} /><Skeleton height={180} /><Skeleton height={180} /></div>
        </div>
      ) : !catalog.available ? (
        <StateCard icon={<BoxesIcon />} title={t('bundlesNoneTitle')} body={t('bundlesNoneBody')} />
      ) : (
        <>
          {!billing.enabled ? <Notice variant="info">{t('storeBillingOff')}</Notice> : null}

          {/* ── Status strip ── */}
          {billing.enabled ? (
            <section className="fstore-strip" aria-label={t('storeStripLabel')}>
              <div className="surface-card fstore-strip__cell">
                <span className="u-text-sm muted">{t('storeYourPlan')}</span>
                {sub ? <strong>{currentPlan?.name ?? t(`billing:plan_${sub.planTier}`)}</strong>
                  : subFailed ? <span className="u-text-sm muted">{t('storePlanUnknown')}</span> : <Skeleton width="40%" />}
                {sub && sub.status === 'trialing' ? <span className="chip chip--accent">{t('storeTrialing')}</span> : null}
              </div>
              <div className="surface-card fstore-strip__cell">
                <span className="u-text-sm muted">{t('storeYourBundles')}</span>
                <strong>{t('storeBundlesSummary', { owned: counts.owned, included: counts.included, free: counts.free })}</strong>
                {counts.owned > 0 ? (
                  <Button variant="link" className="u-justify-start" onClick={() => setFilter('owned')}>{t('storeSeeOwned')}</Button>
                ) : null}
              </div>
              {/* ADR 0821 — tenant-wide AI spend is admin-class server-side, so the
                  meter is offered only to a caller who may manage billing. */}
              {canBuy ? (
                <div className="fstore-strip__meter">
                  <Suspense fallback={<div className="surface-card u-p-4"><Skeleton /></div>}><AiCreditMeter /></Suspense>
                </div>
              ) : null}
            </section>
          ) : null}
          {billing.enabled && storeBundles.length > 0 && !canBuy ? <p className="muted u-m-0">{t('buyAdminsOnly')}</p> : null}

          {/* ── Plans ── */}
          {showPlans ? (
            <section className="u-grid u-gap-3" aria-labelledby="store-plans-h">
              <div className="u-flex u-flex-wrap u-items-center u-justify-between u-gap-2">
                <h2 id="store-plans-h" className="u-m-0">{t('storePlansTitle')}</h2>
                <Button
                  variant="link"
                  aria-expanded={compareOpen}
                  aria-controls="store-compare"
                  onClick={() => setParam('view', compareOpen ? null : 'compare', true)}
                >
                  {compareOpen ? t('storeCompareHide') : t('storeCompareShow')}
                </Button>
              </div>
              <div className="card-grid">{plans.map(renderPlan)}</div>
            </section>
          ) : null}
          {showPlans && compareOpen ? (
            <section id="store-compare" className="u-grid u-gap-2" aria-labelledby="store-compare-h">
              <h2 id="store-compare-h" className="u-m-0">{t('storeCompareTitle')}</h2>
              <BundleCompareTable plans={plans} bundles={storeBundles} commerceById={commerceById} currentTier={currentTier} cadence={cadence} />
            </section>
          ) : null}

          {/* ── Bundles, grouped by catalog data ── */}
          <section className="u-grid u-gap-3" aria-labelledby="store-bundles-h">
            <div className="u-grid u-gap-2">
              <div className="u-grid u-gap-0-5">
                <h2 id="store-bundles-h" className="u-m-0">{showPlans ? t('storeBundlesTitleAddon') : t('storeBundlesTitle')}</h2>
                <span className="u-text-sm muted">{priced ? t(cadence === 'year' ? 'storeBundlesLedeYearly' : 'storeBundlesLedeMonthly') : t('storeBundlesLedeUnpriced')}</span>
              </div>
              {priced && storeBundles.length > 0 ? (
                <div className="fstore-filters" role="group" aria-label={t('storeFilterLabel')}>
                  {(['all', 'available', 'free', 'owned', 'included'] as Filter[])
                    .filter((f) => f === 'all' || f === 'available' || counts[f] > 0 || filter === f)
                    .map((f) => (
                      <Button
                        key={f}
                        variant="primary"
                        className={`chip fstore-filter${filter === f ? ' is-selected' : ''}`}
                        aria-pressed={filter === f}
                        onClick={() => setFilter(f)}
                      >
                        {filterLabel[f]} <span className="fstore-filter__count">{counts[f]}</span>
                      </Button>
                    ))}
                </div>
              ) : null}
            </div>
            {billing.enabled && storeBundles.length === 0 ? (
              <StateCard icon={<SparklesIcon />} title={t('storeEmptyTitle')} body={t('storeEmptyBody')} />
            ) : shown.length === 0 ? (
              <p className="muted u-m-0">{t('storeFilterEmpty')}</p>
            ) : (
              groups.map((g) => (
                <div key={g.id || 'other'} className="u-grid u-gap-2">
                  <div className="u-grid u-gap-0-5">
                    <h3 className="u-m-0 u-fs-16">{g.id ? t(`group_${g.id}`, { defaultValue: g.id }) : t('storeGroupOther')}</h3>
                    {g.id ? <span className="u-text-sm muted">{t(`groupSub_${g.id}`, { defaultValue: '' })}</span> : null}
                  </div>
                  <div className="card-grid">{g.bundles.map(renderBundle)}</div>
                </div>
              ))
            )}
          </section>

          {/* ── AI credits (ADR 0821 D7) — hidden unless a pack is configured ── */}
          <CreditPacksStrip enabled={billing.enabled} canBuy={canBuy} buying={buying} onBuy={buyPack} />

          {/* ── Always free + FAQ ── */}
          <div className="fstore-info">
            {coreLabels.length ? (
              <section className="surface-card u-p-4 u-grid u-gap-2" aria-labelledby="store-free-h">
                <h2 id="store-free-h" className="u-m-0 u-fs-16">{t('storeAlwaysFreeTitle')}</h2>
                <p className="u-m-0 u-text-sm muted">{t('storeAlwaysFreeBody', { count: coreLabels.length })}</p>
                <div className="u-flex u-flex-wrap u-gap-1">
                  {coreLabels.slice(0, 12).map((l) => <span key={l} className="chip chip--muted">{l}</span>)}
                  {coreLabels.length > 12 ? <span className="chip chip--muted">{t('storeAndMore', { count: coreLabels.length - 12 })}</span> : null}
                </div>
              </section>
            ) : null}
            {billing.enabled ? (
              <section className="surface-card u-p-4 u-grid u-gap-2" aria-labelledby="store-faq-h">
                <h2 id="store-faq-h" className="u-m-0 u-fs-16">{t('storeFaqTitle')}</h2>
                <ul className="u-m-0 u-grid u-gap-1 u-text-sm">
                  <li>{t('storeFaqSeats')}</li>
                  {maxTrial > 0 ? <li>{t('storeFaqTrial', { count: maxTrial })}</li> : null}
                  <li>{t('storeFaqCancel')}</li>
                </ul>
              </section>
            ) : null}
          </div>

        </>
      )}

      {openBundle && catalog ? (
        <BundleDetailPanel
          bundle={openBundle}
          commerce={commerceById.get(openBundle.id)}
          bundles={bundles}
          commerceById={commerceById}
          plans={plans}
          currentTier={currentTier}
          cadence={cadence}
          onCadence={setCadence}
          canBuy={canBuy && priced}
          buying={buying !== null}
          onBuy={buy}
          onClose={() => setParam('bundle', null, true)}
          onCompare={() => {
            const next = new URLSearchParams(params); next.delete('bundle'); next.set('view', 'compare'); setParams(next, { replace: true });
          }}
        />
      ) : null}
    </div>
  );
}
