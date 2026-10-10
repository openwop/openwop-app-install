/**
 * Locked-feature upgrade prompt — the DATA half (ADR 0419 §8 follow-on, ADR 0820 §7).
 *
 * A locked feature (toggle on, plan/bundles do not entitle it) used to say only
 * "this feature needs an upgrade" and link to the bare store. This resolves WHICH
 * bundle sells it and what that costs, from the same three reads the store makes:
 *
 *  - the bundle catalog (`/marketplace/feature-bundles`): feature → bundle
 *    membership, from `distributions/bundles.json`. Never a UI-side map;
 *  - the billing store projection (`/billing/bundles`): `purchasable`, the
 *    operator's display copy (`priceDisplay`) and `cadences`;
 *  - the public plan catalog (`/public/pricing`): a plan that covers the bundle
 *    and is the better buy, computed by the store's own `cheaperPlanFor`.
 *
 * Every read is cached for the SESSION in a module-level promise, so a page with
 * several locked items (or the nav plus a locked page) fetches each once. A
 * rejected read is dropped from the cache, so the next caller retries instead of
 * inheriting a failure. Prices come only from the operator's display strings;
 * nothing here invents one.
 *
 * Loaded lazily (through `featureToggles/LockedState`), never from the entry chunk.
 */
import {
  fetchBundleCommerce, fetchFeatureBundles, fetchPublicPricing,
  type BundleCommerce, type FeatureBundleCatalog, type FeatureBundleInfo, type PublicPlanTier,
} from './marketplaceClient.js';
import { bundlePrice, canPurchase, cheaperPlanFor } from './bundleStoreModel.js';
import i18n from '../../i18n/index.js';

export interface UpsellData {
  catalog: FeatureBundleCatalog;
  commerce: BundleCommerce[];
  plans: PublicPlanTier[];
}

/** The owning bundle of a locked feature, as the nav needs it (no prices). */
export interface LockedBundleRef { id: string; label: string }

/** What the locked prompt renders for one feature. */
export interface LockedUpsell {
  bundle: FeatureBundleInfo;
  /** The operator's one-line value copy (`BUNDLE_DISPLAY.blurb`), when published. */
  blurb?: string;
  /** A checkout would be accepted (server `purchasable`). False = honest no-CTA copy. */
  purchasable: boolean;
  /** "$19/mo" — only for a purchasable bundle whose monthly price is published. */
  monthly?: string;
  /** "$190/yr" — only when the bundle sells yearly AND the amount is published. */
  yearly?: string;
  /** A paid plan that covers this bundle and is cheaper than its bundles bought separately. */
  plan?: { name: string; price: string; bundles: number };
}

let catalogP: Promise<FeatureBundleCatalog> | null = null;
let dataP: Promise<UpsellData> | null = null;

/** Session-cached bundle catalog. */
export function loadCatalog(): Promise<FeatureBundleCatalog> {
  catalogP ??= fetchFeatureBundles().catch((err: unknown) => { catalogP = null; throw err; });
  return catalogP;
}

/** Session-cached catalog + store + plans. A failed store read is NOT cached
 *  (that would pin "nothing for sale" for the session); a failed plans read just
 *  means no plan line. */
export function loadUpsellData(): Promise<UpsellData> {
  if (dataP) return dataP;
  let storeFailed = false;
  const p = Promise.all([
    loadCatalog(),
    fetchBundleCommerce().catch(() => { storeFailed = true; return [] as BundleCommerce[]; }),
    fetchPublicPricing().catch(() => [] as PublicPlanTier[]),
  ]).then(([catalog, commerce, plans]) => {
    if (storeFailed && dataP === p) dataP = null;
    return { catalog, commerce, plans };
  }, (err: unknown) => {
    if (dataP === p) dataP = null;
    throw err;
  });
  dataP = p;
  return p;
}

/** feature id → owning bundle, for the nav's lock tooltip and link. */
export async function featureBundleIndex(): Promise<Record<string, LockedBundleRef>> {
  const catalog = await loadCatalog();
  const out: Record<string, LockedBundleRef> = {};
  for (const b of catalog.bundles) for (const f of b.features) out[f.id] ??= { id: b.id, label: b.label };
  return out;
}

/**
 * The nav's lock targets (`featureToggles/lockedTargets` loads this lazily): the
 * href that opens the unlocking bundle's drawer and the lock label naming it, or
 * `undefined` for a feature no bundle sells (the caller keeps its own). The label
 * is translated at call time, so it follows a language switch; the `marketplace`
 * namespace is loaded before this resolves.
 */
export async function lockedTargets(): Promise<{ href(id?: string): string | undefined; label(id?: string): string | undefined }> {
  const [ix] = await Promise.all([featureBundleIndex(), i18n.loadNamespaces('marketplace')]);
  const of = (id?: string): LockedBundleRef | undefined => (id ? ix[id] : undefined);
  return {
    href: (id) => { const b = of(id); return b ? bundleHref(b.id) : undefined; },
    label: (id) => { const b = of(id); return b ? i18n.t('marketplace:navLockedBundle', { bundle: b.label }) : undefined; },
  };
}

/** The store's detail panel for a bundle (opens it; never starts checkout). */
export const bundleHref = (bundleId: string): string => `/marketplace/bundles?bundle=${encodeURIComponent(bundleId)}`;
/** The store's plans × bundles comparison. */
export const COMPARE_HREF = '/marketplace/bundles?view=compare';

/**
 * Resolve the prompt for `featureId`. `null` when no bundle owns the feature (it is
 * not sellable), and the caller keeps its generic locked copy.
 */
export function resolveUpsell(featureId: string, data: UpsellData): LockedUpsell | null {
  const bundle = data.catalog.bundles.find((b) => b.features.some((f) => f.id === featureId));
  if (!bundle) return null;
  const byId = new Map(data.commerce.map((c) => [c.bundleId, c]));
  const c = byId.get(bundle.id);
  const purchasable = canPurchase(c);
  const out: LockedUpsell = { bundle, purchasable };
  if (c?.priceDisplay?.blurb) out.blurb = c.priceDisplay.blurb;
  if (!purchasable) return out; // no price, no plan line: nothing here can be bought
  const month = bundlePrice(c, 'month');
  const year = bundlePrice(c, 'year');
  if (month.sellsChosen && month.price) out.monthly = `${month.price}${month.cadence ?? ''}`;
  if (year.sellsChosen && year.price) out.yearly = `${year.price}${year.cadence ?? ''}`;
  // The current tier never covers a LOCKED feature's bundle, so `cheaperPlanFor`
  // needs no subscription read to exclude it.
  const better = cheaperPlanFor(bundle, data.plans, data.catalog.bundles, byId, null);
  if (better?.plan.display?.price) {
    out.plan = {
      name: better.plan.name,
      price: `${better.plan.display.price}${better.plan.display.cadence ?? ''}`,
      bundles: better.others.length + 1,
    };
  }
  return out;
}

/** Test seam — forget the session cache. */
export function __resetLockedUpsellCacheForTest(): void {
  catalogP = null;
  dataP = null;
}
