/**
 * Marketplace (host-extension product feature — ADR 0022). Browse signed feature
 * packs (install status + aggregate rating), install (superadmin — a 403 is
 * surfaced as a clear message), and review. Gates on useFeatureAccess('marketplace'):
 * hidden in nav when off, a disabled StateCard on the page when off.
 *
 * Reviews are ORG-scoped, so an org picker drives the detail panel's reviews.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatCurrency, formatDate, formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { DeepLinkMissNotice, isDeepLinkMiss } from '../../ui/DeepLinkMissNotice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { BoxesIcon, LockIcon, StarIcon, TrashIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { confirm } from '../../ui/confirm.js';
import { handleRadiogroupKeyDown } from '../../ui/rovingTabs.js';
import {
  listListings, installPack, listOrgs, listReviews, postReview, deleteReview,
  fetchDisabledPacks, setPackEnabled, removePack, restorePack,
  type Listing, type Review, type RatingSummary, type Org,
  purchaseListing, getPurchaseOrder, listMyOrders, type PurchaseOrder,
} from './marketplaceClient.js';
import { ListingCard, ListingRow } from './MarketplaceViews.js';

/** MKT-UX-5 — the caller's LATEST actionable order state per pack. `purchases` is
 *  newest-first from the route, so the first row per pack is its latest order; only
 *  `pending` / `failed` produce a chip (a paid pack shows the "Purchased" chip via
 *  the listing's own `pricing.purchased`, and refunded/disputed are the seller's
 *  console concern, not the buy card's). */
function deriveOrderStatuses(purchases: PurchaseOrder[]): Map<string, 'pending' | 'failed'> {
  const latest = new Map<string, PurchaseOrder>();
  for (const o of purchases) if (!latest.has(o.packName)) latest.set(o.packName, o);
  const out = new Map<string, 'pending' | 'failed'>();
  for (const [pack, o] of latest) {
    if (o.status === 'pending') out.set(pack, 'pending');
    else if (o.status === 'failed') out.set(pack, 'failed');
  }
  return out;
}
import { deriveFacets, applyFilters, anyFilterActive, EMPTY_FILTERS, type MarketplaceFilters, type PackStatus } from './marketplaceFilter.js';

const when = (iso: string): string => { try { return formatDate(iso); } catch { return iso; } };
const authorLabel = (id: string): string => (id.startsWith('agent:') ? i18n.t('marketplace:authorAgent') : id);

/**
 * A 1–5 star row. Read-only (`onPick` absent): a single labelled `img` role
 * announcing "N out of 5 stars" (the individual glyphs are decorative). Interactive
 * (`onPick` present): a proper `radiogroup` of `radio` buttons (`aria-checked`),
 * each with a per-star label, so the rating is keyboard- and screen-reader-operable.
 */
function Stars({ value, onPick, label }: { value: number; onPick?: (n: number) => void; label?: string }): JSX.Element {
  const { t } = useTranslation('marketplace');
  const stars = [1, 2, 3, 4, 5];
  if (!onPick) {
    return (
      <span className="mkt-stars" role="img" aria-label={t('starsReadLabel', { count: Math.round(value) })}>
        {stars.map((n) => (
          <span key={n} className="mkt-star" aria-hidden>
            <StarIcon fill={n <= Math.round(value) ? 'currentColor' : 'none'} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="mkt-stars" role="radiogroup" aria-label={label ?? t('ratingLabel')}
      onKeyDown={handleRadiogroupKeyDown}>
      {stars.map((n) => (
        <Button
          key={n}
          role="radio"
          aria-checked={n === value}
          // KTUX-8 — roving tabIndex: the group is one tab stop landing on the
          // selected star (or the first when none is picked yet).
          tabIndex={n === value || (value === 0 && n === 1) ? 0 : -1}
          variant="quiet" className="mkt-star-btn"
          aria-label={t('starLabel', { count: n })}
          onClick={() => onPick(n)}
        >
          <StarIcon fill={n <= value ? 'currentColor' : 'none'} />
        </Button>
      ))}
    </span>
  );
}

export function MarketplacePage(): JSX.Element {
  const { t } = useTranslation('marketplace');
  const access = useFeatureAccess('marketplace');
  const [listings, setListings] = useState<Listing[] | null>(null);
  // MKT-UX-5 — the caller's latest actionable order state per pack (`pending` /
  // `failed`) so a card is no longer identical between "checkout in flight",
  // "payment failed" and "never tried". Built from the own-orders route alongside
  // the listings; empty on a read failure (never a fabricated purchase state).
  const [ordersByPack, setOrdersByPack] = useState<Map<string, 'pending' | 'failed'>>(new Map());
  const [wsDisabled, setWsDisabled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | PackStatus>('');
  // Deep-link spine (ADR 0336): the open reviews panel rides ?pack= — the URL
  // owns it, so a link/reload restores it (selectedListing below is the validity
  // guard: a pack the list doesn't have reads as closed).
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('pack');
  const setSelected = useCallback((packName: string | null) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (packName) n.set('pack', packName); else n.delete('pack'); return n; }, { replace: true });
  }, [setSearchParams]);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useViewMode('marketplace', 'grid');
  /** The workspace curation read failed — which packs are hidden is UNKNOWN. The
   *  availability control is inert while this holds; a checkbox reflecting a
   *  fabricated set is worse than no checkbox, and its write derives from it. */
  const [curationUnknown, setCurationUnknown] = useState(false);
  // MKT2-M1 (R3) — the server's disclosure that pricing enrichment failed:
  // paid packs may be missing purchase affordances; say so, never render-as-free.
  const [pricingDegraded, setPricingDegraded] = useState(false);
  // MKT2-M2 (R3) — failure is its own state (the error used to sit above a
  // permanent skeleton with no retry).
  const [listingsFailed, setListingsFailed] = useState(false);

  const load = useCallback(() => {
    setError(null);
    // Listings + the workspace's disabled set (ADR 0194 P3) load together. Not
    // blanking browse on a curation-read failure is right and is kept — but
    // degrading to "nothing disabled" is not the way to do it: `wsDisabled` drives
    // a CHECKBOX (`checked={!wsDisabled}`, "Available in workspace") and the
    // "Hidden in workspace" chip, so an empty set renders every pack as AVAILABLE
    // — including ones the workspace has deliberately hidden — and
    // `toggleAvailability` computes its write from that same fabricated set.
    // Right intent, inverted conclusion.
    setCurationUnknown(false);
    setListingsFailed(false);
    void Promise.all([
      listListings(),
      fetchDisabledPacks().catch(() => { setCurationUnknown(true); return [] as string[]; }),
      // MKT-UX-5 — own orders alongside the listings; a read failure is [] (no chip),
      // never a fabricated purchase state. Does not gate the page on the orders read.
      listMyOrders().catch(() => ({ purchases: [] as PurchaseOrder[], sales: [] as PurchaseOrder[] })),
    ])
      .then(([ls, disabled, orders]) => { setListings(ls.listings); setPricingDegraded(ls.pricingDegraded); setWsDisabled(new Set(disabled)); setOrdersByPack(deriveOrderStatuses(orders.purchases)); setError(null); })
      .catch((err) => {
        setListingsFailed(true);
        // MKT-UX-13 — clear the STALE degraded flag. Two reasons, one line.
        // (a) Honesty: "paid packs may not show their purchase options" is a
        //     claim about a read that SUCCEEDED with partial data; after a read
        //     that failed outright we know nothing about pricing.
        // (b) `announce()` has a single polite slot, so two announced regions in
        //     one paint means the second silently replaces the first. A Retry
        //     that fails after a degraded success would otherwise leave both
        //     mounted and make which one is spoken a race.
        setPricingDegraded(false);
        setError(err instanceof Error ? err.message : t('loadFailed'));
      });
  }, [t]);

  useEffect(() => { if (access.enabled) load(); }, [access.enabled, load]);

  /**
   * MKT-UX-2 / MKT-UX-5 — the post-checkout receipt.
   *
   * Stripe used to return a paying buyer to `/commerce-connect?purchase=success`
   * — the SELLER-ONBOARDING page — and nothing in the SPA read `?purchase` at
   * all, so the param persisted unread and the typical (non-seller) buyer was
   * shown "Become a seller … Start selling" immediately after a completed
   * charge: no amount, no pack, no order id, no fulfilment expectation.
   *
   * The receipt is built from the ORDER, not from optimism. Fulfilment rides the
   * `checkout.session.completed` webhook, so `pending` is the honest state to
   * report on arrival and the catalog is re-read so a webhook that has already
   * landed shows as Purchased. An order we cannot READ is reported as exactly
   * that — never as a failed purchase, which would be a claim about money we
   * have not verified.
   */
  useEffect(() => {
    const outcome = searchParams.get('purchase');
    if (!outcome) return;
    const orderId = searchParams.get('order');
    const pack = searchParams.get('pack') ?? '';
    const strip = (): void => setSearchParams((prev) => {
      const n = new URLSearchParams(prev);
      n.delete('purchase'); n.delete('order');
      return n;
    }, { replace: true });

    if (outcome === 'cancelled') { toast.info(t('purchaseCancelled', { pack })); strip(); return; }
    if (outcome !== 'success') { strip(); return; }

    void (async () => {
      const order = orderId ? await getPurchaseOrder(orderId) : null;
      if (!order) {
        toast.info(t('purchaseReceiptUnavailable'));
      } else if (order.status === 'pending') {
        toast.success(t('purchaseReceiptPending', {
          pack: order.packName,
          amount: formatCurrency(order.amountMajorUnits, order.currency),
        }));
      } else if (order.status === 'failed') {
        toast.error(t('purchaseReceiptFailed', { pack: order.packName }));
      } else {
        toast.success(t('purchaseReceiptPaid', {
          pack: order.packName,
          amount: formatCurrency(order.amountMajorUnits, order.currency),
        }));
      }
      load(); // re-read the catalog: the webhook may already have landed
      strip();
    })();
    // `searchParams` is read once per arrival; `strip()` clears the trigger.
  }, [searchParams, setSearchParams, load, t]);

  // Facet options are derived from the loaded catalog so a filter never offers a
  // value that matches nothing (and the Status list only shows states that exist —
  // e.g. "Removed" appears only to superadmins who can see tombstoned packs).
  const facets = useMemo(() => deriveFacets(listings ?? []), [listings]);
  const filters = useMemo<MarketplaceFilters>(
    () => ({ query, type: typeFilter, domain: domainFilter, vendor: vendorFilter, status: statusFilter }),
    [query, typeFilter, domainFilter, vendorFilter, statusFilter],
  );
  const filtered = useMemo(() => (listings ? applyFilters(listings, filters) : null), [listings, filters]);
  const anyActive = anyFilterActive(filters);

  // MPL-20 — the empty shape comes from the ONE constant the filter module
  // exports, instead of being rebuilt inline. `EMPTY_FILTERS` was consumed only
  // by its own test, which is the shape where a field added to
  // `MarketplaceFilters` gets cleared in one place and not the other.
  const clearFilters = useCallback(() => {
    setQuery(EMPTY_FILTERS.query);
    setTypeFilter(EMPTY_FILTERS.type);
    setDomainFilter(EMPTY_FILTERS.domain);
    setVendorFilter(EMPTY_FILTERS.vendor);
    setStatusFilter(EMPTY_FILTERS.status);
  }, []);

  // ADR 0385 P4 — start a native-paid purchase; live mode redirects to Stripe
  // Checkout, demo mode explains the sentinel. Fulfilment rides the webhook.
  const purchase = useCallback(async (l: Listing) => {
    setBusy(true);
    try {
      const r = await purchaseListing(l.packName);
      // MKT-UX-9 — branch on `mode` ALONE. This used to be
      // `if (mode === 'live' && /^https:/.test(url))`, so a LIVE response whose
      // url was empty, `http://`, or otherwise unusable fell through to the DEMO
      // toast — "no Stripe key is configured … recorded as a pending demo order"
      // — asserting the ABSENCE OF A CHARGE to a user whose live checkout session
      // may well exist server-side. The demo sentinel is `demo:checkout:<id>`,
      // which that regex also rejects, so the two branches were conflated by
      // construction rather than distinguished. Three states, three sentences.
      if (r.mode === 'live') {
        if (/^https:\/\//.test(r.url)) { window.location.href = r.url; return; }
        toast.error(t('purchaseCheckoutUnavailable', { pack: l.packName }));
        // MKT-UX-5 — the checkout already CAS-wrote a `pending` order server-side,
        // so refresh the orders map (mirrors install/remove) or the pending chip +
        // disabled Buy would not appear until a manual reload.
        load();
        return;
      }
      toast.info(t('purchaseDemo', { pack: l.packName }));
      // MKT-UX-5 — the demo lane ALSO writes a durable `pending` order. Without this
      // the feature never visibly engages on the primary demoed path (the deployed
      // host has no Stripe key, so every purchase is demo): the card would stay on
      // the bare price chip with Buy enabled until a reload.
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('purchaseFailed'));
    } finally {
      setBusy(false);
    }
  }, [t, load]);

  const install = useCallback(async (l: Listing) => {
    setBusy(true);
    try {
      const r = await installPack({ packName: l.packName, version: l.version });
      toast.success(r.alreadyInstalled ? t('alreadyInstalled', { pack: l.packName }) : t('installedToast', { pack: l.packName }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('installFailed'));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  // ADR 0194 P4 — two-tier removal (superadmin; the backend is the authority and
  // surfaces a clear 403 for non-superadmins). Both steps confirm (destructive).
  const remove = useCallback(async (l: Listing) => {
    if (!(await confirm({ title: t('removeConfirm', { pack: l.packName }), body: t('removeConfirmBody'), danger: true, confirmLabel: t('removePack') }))) return;
    setBusy(true);
    try {
      await removePack(l.packName);
      toast.success(t('removedToast', { pack: l.packName }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('removeFailed'));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const restore = useCallback(async (l: Listing) => {
    setBusy(true);
    try {
      await restorePack(l.packName);
      toast.success(t('restoredToast', { pack: l.packName }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('restoreFailed'));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const purge = useCallback(async (l: Listing) => {
    if (!(await confirm({ title: t('purgeConfirm', { pack: l.packName }), body: t('purgeConfirmBody'), danger: true, confirmLabel: t('purgePack') }))) return;
    setBusy(true);
    try {
      await removePack(l.packName, { purge: true });
      toast.success(t('purgedToast', { pack: l.packName }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('purgeFailed'));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  // ADR 0194 P3 — workspace availability curation (optimistic; reverts on failure).
  const toggleAvailability = useCallback(async (l: Listing) => {
    // Never write from a set we could not read — the value would be a guess.
    if (curationUnknown) return;
    const nextEnabled = wsDisabled.has(l.packName);
    setBusy(true);
    try {
      await setPackEnabled(l.packName, nextEnabled);
      setWsDisabled((prev) => {
        const next = new Set(prev);
        if (nextEnabled) next.delete(l.packName);
        else next.add(l.packName);
        return next;
      });
      toast.success(nextEnabled ? t('availabilityOn', { pack: l.packName }) : t('availabilityOff', { pack: l.packName }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('availabilityFailed'));
    } finally {
      setBusy(false);
    }
  }, [wsDisabled, curationUnknown, t]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return (
      <section data-walkthrough="marketplace.page" className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  const selectedListing = selected ? (listings ?? []).find((l) => l.packName === selected) ?? null : null;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {/* ADR 0366 P3 — the bundle shop rides the same feature (no second nav entry) */}
      <p className="muted"><Link to="/marketplace/bundles">{t('bundleShopLink')}</Link></p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {curationUnknown ? <Notice variant="warning">{t('curationUnknown')}</Notice> : null}

      <div className="filterbar" role="group" aria-label={t('filterGroup')}>
        <input
          type="search"
          className="ui-input filterbar-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPacksLabel')}
        />
        <select className="ui-input filterbar-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label={t('filterTypeLabel')}>
          <option value="">{t('allTypes')}</option>
          {facets.types.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="ui-input filterbar-select" value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} aria-label={t('filterCategoryLabel')}>
          <option value="">{t('allCategories')}</option>
          {facets.domains.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="ui-input filterbar-select" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} aria-label={t('filterVendorLabel')}>
          <option value="">{t('allVendors')}</option>
          {facets.vendors.map((v) => <option key={v} value={v}>{authorLabel(v)}</option>)}
        </select>
        <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | PackStatus)} aria-label={t('filterStatusLabel')}>
          <option value="">{t('allStatuses')}</option>
          {facets.statuses.map((s) => (
            <option key={s} value={s}>{t(s === 'installed' ? 'statusInstalled' : s === 'available' ? 'statusAvailable' : 'statusRemoved')}</option>
          ))}
        </select>
        {anyActive ? (
          <Button variant="quiet" onClick={clearFilters}>{t('clearFilters')}</Button>
        ) : null}
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
      </div>
      {filtered !== null && anyActive ? (
        <p className="u-text-sm u-text-muted" aria-live="polite" role="status">
          {t('resultCount', { shown: filtered.length, total: (listings ?? []).length })}
        </p>
      ) : null}
      <DeepLinkMissNotice show={isDeepLinkMiss(selected, listings !== null, selectedListing)} onClear={() => setSelected(null)} />

      {/* MKT-UX-13 — ANNOUNCED. `ui/Notice` documents that a conditionally-mounted
          Notice arrives with its text already inside and therefore announces
          NOTHING unless `announce` is passed; `variant="warning"` is `role="status"`,
          silent on insertion. This is the one notice on the page whose entire
          purpose is to correct a MONEY impression — "paid packs may not show
          their purchase options right now. They are not free" — so a screen-reader
          user was the one person who could not hear it. It cannot contend for
          the single polite slot with the `listingsFailed` StateCard below: this
          flag is set only by a SUCCESSFUL read and is now cleared in the catch. */}
      {pricingDegraded ? (
        <Notice variant="warning" announce={t('pricingDegradedNotice')}>{t('pricingDegradedNotice')}</Notice>
      ) : null}
      {listingsFailed ? (
        <StateCard
          announce
          icon={<BoxesIcon />}
          title={t('listingsFailedTitle')}
          body={t('listingsFailedBody')}
          action={<Button variant="secondary" onClick={load}>{t('common:retry')}</Button>}
        />
      ) : filtered === null ? (
        <Skeleton />
      ) : filtered.length === 0 ? (
        <StateCard icon={<BoxesIcon />} title={t('noPacksFoundTitle')} body={anyActive ? t('noPacksFoundBodyFiltered') : t('noPacksFoundBodyEmpty')} />
      ) : viewMode === 'grid' ? (
        <ul className="card-grid mkt-list" aria-label={t('packsLabel')}>
          {filtered.map((l) => (
            <ListingCard
              key={l.packName}
              listing={l}
              busy={busy}
              wsDisabled={wsDisabled.has(l.packName)}
              curationUnknown={curationUnknown}
              onReviews={() => setSelected(l.packName)}
              onInstall={() => void install(l)}
              onToggleAvailability={() => void toggleAvailability(l)}
              onRemove={() => void remove(l)}
              onRestore={() => void restore(l)}
              onPurge={() => void purge(l)}
              onPurchase={() => void purchase(l)}
              orderStatus={ordersByPack.get(l.packName)}
            />
          ))}
        </ul>
      ) : (
        <div role="region" className="surface-card list-view" aria-label={t('packsLabel')}>
          {filtered.map((l) => (
            <ListingRow
              key={l.packName}
              listing={l}
              busy={busy}
              wsDisabled={wsDisabled.has(l.packName)}
              curationUnknown={curationUnknown}
              onReviews={() => setSelected(l.packName)}
              onInstall={() => void install(l)}
              onToggleAvailability={() => void toggleAvailability(l)}
              onRemove={() => void remove(l)}
              onRestore={() => void restore(l)}
              onPurge={() => void purge(l)}
              onPurchase={() => void purchase(l)}
              orderStatus={ordersByPack.get(l.packName)}
            />
          ))}
        </div>
      )}

      {selectedListing ? (
        <ReviewsPanel listing={selectedListing} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}

/** Org-scoped reviews for one pack: pick an org, see the aggregate + reviews, rate. */
function ReviewsPanel({ listing, onClose }: { listing: Listing; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('marketplace');
  // `.catch(() => setOrgs([]))` left `orgId` '' and the reviews read is gated
  // on it, so `reviews` stayed null and the skeleton below never resolved.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [summary, setSummary] = useState<RatingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The reviews read FAILED — distinct from "this pack has no reviews". */
  const [reviewsFailed, setReviewsFailed] = useState(false);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);


  const load = useCallback((org: string) => {
    if (!org) return;
    setError(null); setReviews(null); setReviewsFailed(false);
    void listReviews(org, listing.packName)
      .then((r) => { setReviews(r.reviews); setSummary(r.summary); })
      // NOT `setReviews([])` — that lands on "No reviews yet", rendered BESIDE
      // the error. On a marketplace listing that reads as "nobody has reviewed
      // this pack", which is a claim about the pack, not about the request.
      .catch((e) => { setReviewsFailed(true); setError(e instanceof Error ? e.message : t('loadReviewsFailed')); });
  }, [listing.packName, t]);

  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const submit = useCallback(async () => {
    if (rating < 1) { toast.error(t('pickRating')); return; }
    setBusy(true);
    try {
      await postReview(orgId, listing.packName, { rating, ...(body.trim() ? { body: body.trim() } : {}) });
      setBody(''); setRating(0);
      load(orgId);
      toast.success(t('reviewSaved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('reviewFailed'));
    } finally { setBusy(false); }
  }, [orgId, listing.packName, rating, body, load, t]);

  const remove = useCallback(async (r: Review) => {
    if (!(await confirm({ title: t('deleteReviewConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deleteReview(orgId, listing.packName, r.reviewId); load(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, listing.packName, load, t]);

  /**
   * The read SUCCEEDED and this tenant genuinely has no ORGANIZATION. Not the
   * same noun as the shell's workspace switcher: that reads `listMyWorkspaces`,
   * which synthesizes a "Personal sandbox" row for a non-durable caller, while
   * this reads `listOrgs`, which returns `[]`. Copy here must say organization,
   * or the page contradicts an active workspace visible in the sidebar — which
   * is why the COPY and the branch order now live in one place
   * (`ui/OrgSelectionState`, rendered below).
   *
   * This flag stays, because two things OTHER than the state card key on it: the
   * rating form (no organization ⇒ no write target ⇒ `postReview('', …)`) and
   * the panel head's summary line. Both need the fact, not the card.
   */
  const noOrgs = !orgsFailed && orgs !== null && orgs.length === 0;

  const orgPicker = orgs && orgs.length > 1 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div role="region" className="surface-card u-p-4 u-grid u-gap-3" aria-label={t('reviewsForLabel', { pack: listing.packName })}>
      <div className="mkt-card-head">
        <div className="u-grid u-gap-1">
          <span className="mkt-card-title">{t('reviewsForTitle', { pack: listing.packName })}</span>
          {/* `summary === null` is NOT "this pack has no reviews" — it is also
              every state in which the summary was never read: no organization to
              scope the request to, a failed org read, a failed reviews read. The
              head used to render "No reviews yet" in all of them, so the panel
              said "No organizations" and "No reviews yet" at once, and the second
              was a claim about data nobody fetched. The head now stays silent
              unless a real summary arrived or a genuine empty answer came back;
              the body below owns the one honest state. */}
          {summary && summary.average !== null ? (
            <span className="mkt-summary"><Stars value={summary.average} /> <span className="u-text-muted">{t('reviewsSummary', { average: formatNumber(summary.average), total: formatNumber(summary.count) })}</span></span>
          ) : orgsFailed || reviewsFailed || noOrgs || reviews === null ? null : (
            <span className="u-text-muted">{t('noReviewsInline')}</span>
          )}
        </div>
        {orgPicker}
        <Button variant="quiet" onClick={onClose} aria-label={t('closeReviewsLabel')}>{t('common:close')}</Button>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* HG-4 — `variant="inline"`: this is a panel inside the marketplace page,
          not a page of its own, so the compact `InlineState` shape is right here
          while every other consumer takes the full `StateCard`. The ORDER is the
          component's: org-failure, then zero-orgs, then the panel's own states.
          It sat below `reviewsFailed` before, which made the panel's answer
          depend on two INDEPENDENT flags never being true together. They can be:
          `reviewsFailed` is cleared only by `load`, which returns early with no
          org, while `useOrgSelection.retry` re-runs the org read and may answer
          `[]`. Ordering must not rest on an unreachability argument — and now it
          cannot, because the branches are not this file's to reorder. */}
      <OrgSelectionState variant="inline" orgs={orgs} orgsFailed={orgsFailed}
        retry={retryOrgs} emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}>
      {/* INSIDE the wrapper now. `noOrgs ? null :` suppressed this form for a
          zero-organization tenant but NOT for a failed organization read, so
          over that failure the panel offered a star rating and a comment box
          whose submit `!orgId` had already made inert — a control that looks
          live, accepts input, and discards it. The wrapper answers all three
          orgless states at once, which is why the page-local flag was never the
          right guard; `noOrgs` survives only for the panel head's summary line,
          which needs the FACT and not the card. */}
      <div className="surface-card u-p-3 surface-form u-grid u-gap-2">
        <div className="u-grid u-gap-1">
          <span className="u-label-sm">{t('yourRating')}</span>
          <Stars value={rating} onPick={setRating} label={t('yourRating')} />
        </div>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('commentOptional')}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={t('commentPlaceholder')} />
        </label>
        {/* Still `!orgId`: the wrapper renders children while the read is IN
            FLIGHT (`orgs === null`), which is the one orgless state left. */}
        <Button variant="primary" disabled={busy || rating < 1 || !orgId} onClick={() => void submit()}>{t('submitReview')}</Button>
      </div>
      {reviewsFailed ? (
        <StateCard announce icon={<StarIcon />} title={t('reviewsFailedTitle')} body={t('reviewsFailedBody')}
          action={<Button variant="secondary" onClick={() => load(orgId)}>{t('orgsRetry')}</Button>} />
      ) : reviews === null ? <Skeleton /> : reviews.length === 0 ? (
        <StateCard icon={<StarIcon />} title={t('noReviewsTitle')} body={t('noReviewsBody')} />
      ) : (
        <ul className="u-grid u-gap-2 mkt-reviews">
          {reviews.map((r) => (
            <li key={r.reviewId} className="surface-card u-p-3 mkt-review">
              <div className="mkt-review-head">
                <Stars value={r.rating} />
                <span className="u-text-muted">{authorLabel(r.authorId)} · {when(r.createdAt)}</span>
                {/* MKT-UX-11 — `variant="danger"`, the convention `ui/ConfirmDialog`
                    names for irreversible actions.
                    MKT-UX-22 (render only for the author or an org admin) is
                    DEFERRED, deliberately: this panel has no caller identity to
                    compare `authorId` against, and plumbing one in wrong would
                    HIDE the control from someone who can use it — a worse failure
                    than the current one, where the backend refuses and the user
                    sees `deleteFailed`. It needs a real identity source, not a
                    guess made here. */}
                <Button variant="danger" onClick={() => void remove(r)} aria-label={t('deleteReviewLabel')}><TrashIcon /></Button>
              </div>
              {r.body ? <p className="mkt-review-body">{r.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
      </OrgSelectionState>
    </div>
  );
}
