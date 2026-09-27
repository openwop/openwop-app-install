/**
 * Marketplace feature client (host-extension, non-normative — ADR 0022). Wraps
 * /host/openwop-app/marketplace/*. 404s when the `marketplace` toggle is off; the
 * install route additionally 403s for a non-superadmin caller (surfaced as a clear
 * message). Reviews are org-scoped (`/orgs/:orgId/listings/:packName/reviews`).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Listing {
  packName: string;
  version: string;
  title: string;
  description?: string;
  author?: string;
  category: string;
  integrity?: string;
  publicKeyRef?: string;
  installed: boolean;
  /** MKT2-B2 — provenance, which `installed` does not carry. `installed` means
   *  "has a registry install marker"; a `local` pack is mounted from the host
   *  checkout and is already loaded and running, so rendering it as
   *  "Not installed" is a false claim and offering Install cannot succeed. */
  origin: 'registry' | 'local';
  /** Removed from this host (ADR 0194 P4) — shown flagged, not hidden. */
  tombstoned?: boolean;
  requiredBy?: string[];
  /** ADR 0385 P4 — optional paid-lane pricing annotated per viewer tenant. */
  pricing?: {
    lane: 'free' | 'external-link' | 'native-paid';
    priceMajorUnits?: number;
    currency?: string;
    externalPaymentUrl?: string;
    purchasable?: boolean;
    purchased?: boolean;
  };
}

/** The buyer's order, as the commerce-connect routes return it. MKT-UX-2 — the
 *  checkout route ALREADY returned this and the client typed it away as
 *  `{ url, mode }`, so the amount, fee, currency and order id the receipt needs
 *  were fetched and then discarded. */
export interface PurchaseOrder {
  orderId: string;
  packName: string;
  amountMajorUnits: number;
  currency: string;
  applicationFeeMajorUnits: number;
  status: 'pending' | 'paid' | 'partially-refunded' | 'refunded' | 'disputed' | 'failed';
  mode: 'live' | 'demo';
  createdAt: string;
}

/** MKT-UX-2 / MKT-UX-5 — read one order (buyer or seller only; 404 otherwise, no
 *  existence leak). The route existed with no frontend caller at all, which is
 *  why the post-checkout screen had nothing to show. */
export async function getPurchaseOrder(orderId: string): Promise<PurchaseOrder | null> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/commerce-connect/orders/${encodeURIComponent(orderId)}`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) return null; // an unreadable order is NOT "the purchase failed" — the caller says so
  return ((await res.json()) as { order: PurchaseOrder }).order;
}

/** MKT-UX-5 — the caller's own orders (buyer `purchases` + seller `sales`). The
 *  route existed with no list client, so a catalog card could not tell a pending
 *  or failed purchase apart from never having tried. Returns `[]` on any read
 *  failure — an unreadable order list must never fabricate a purchase state. */
export async function listMyOrders(): Promise<{ purchases: PurchaseOrder[]; sales: PurchaseOrder[] }> {
  try {
    const res = await fetch(`${config.baseUrl}/host/openwop-app/commerce-connect/orders`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return { purchases: [], sales: [] };
    const body = (await res.json()) as { purchases?: PurchaseOrder[]; sales?: PurchaseOrder[] };
    return { purchases: body.purchases ?? [], sales: body.sales ?? [] };
  } catch {
    return { purchases: [], sales: [] };
  }
}

/** ADR 0385 P4 — start a destination-charge purchase (commerce-connect route;
 *  HTTP is the feature boundary — no cross-feature code import). */
export async function purchaseListing(packName: string): Promise<{ order: PurchaseOrder; url: string; mode: 'live' | 'demo' }> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/commerce-connect/purchase/checkout`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ packName }),
  }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* not json */ }
    throw new Error(detail || `purchase returned ${res.status}`);
  }
  return (await res.json()) as { order: PurchaseOrder; url: string; mode: 'live' | 'demo' };
}

export interface Review {
  reviewId: string;
  tenantId: string;
  orgId: string;
  packName: string;
  rating: number;
  body?: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RatingSummary {
  packName: string;
  count: number;
  average: number | null;
}

export interface Org { orgId: string; name: string }

const base = `${config.baseUrl}/host/openwop-app/marketplace`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** MKT2-M1 (R3) — `pricingDegraded` is the server's disclosure that the pricing
 *  enrichment FAILED: paid packs may be missing their purchase affordances, and
 *  the page must say so rather than render them as free. */
export async function listListings(): Promise<{ listings: Listing[]; pricingDegraded: boolean }> {
  const res = await fetch(`${base}/listings`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ listings: Listing[]; pricingDegraded?: boolean }>(res, 'listListings');
  return { listings: body.listings, pricingDegraded: body.pricingDegraded === true };
}

export interface InstallResult {
  packName: string;
  version: string;
  installed: boolean;
  alreadyInstalled: boolean;
  reason?: string;
}

export async function installPack(input: { packName: string; version: string }): Promise<InstallResult> {
  const res = await fetch(`${base}/install`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (res.status === 403) {
    throw new Error('Installing a pack requires a superadmin. Ask an administrator to install it.');
  }
  return asJson<InstallResult>(res, 'installPack');
}

/** Pack names the caller's workspace disabled for authoring (ADR 0194 P3). */
export async function fetchDisabledPacks(): Promise<string[]> {
  const res = await fetch(`${base}/pack-enablement`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ disabled: string[] }>(res, 'fetchDisabledPacks')).disabled;
}

/** Curate one pack's availability in the caller's workspace (ADR 0194 P3). */
export async function setPackEnabled(packName: string, enabled: boolean): Promise<void> {
  const res = await fetch(
    `${base}/pack-enablement/${encodeURIComponent(packName)}`,
    fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ enabled }) }),
  );
  await asJson<{ packName: string; enabled: boolean }>(res, 'setPackEnabled');
}

const SUPERADMIN_HINT = 'This action requires a superadmin.';

/** Tombstone (default) or purge a pack — superadmin (ADR 0194 P4). */
export async function removePack(packName: string, opts?: { purge?: boolean }): Promise<{ tombstoned: boolean; purged: boolean }> {
  const q = opts?.purge ? '?purge=true' : '';
  const res = await fetch(`${base}/packs/${encodeURIComponent(packName)}${q}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (res.status === 403) throw new Error(SUPERADMIN_HINT);
  return asJson<{ tombstoned: boolean; purged: boolean }>(res, 'removePack');
}

/** Restore a removed (tombstoned) pack — superadmin (ADR 0194 P4). */
export async function restorePack(packName: string): Promise<void> {
  const res = await fetch(`${base}/packs/${encodeURIComponent(packName)}/restore`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  if (res.status === 403) throw new Error(SUPERADMIN_HINT);
  await asJson<{ restored: boolean }>(res, 'restorePack');
}

/** The caller's orgs — reviews are org-scoped. Reuses the orgs route. */
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export async function listReviews(orgId: string, packName: string): Promise<{ reviews: Review[]; summary: RatingSummary }> {
  const res = await fetch(
    `${base}/orgs/${encodeURIComponent(orgId)}/listings/${encodeURIComponent(packName)}/reviews`,
    fetchOpts({ headers: authedHeaders() }),
  );
  return asJson<{ reviews: Review[]; summary: RatingSummary }>(res, 'listReviews');
}

export async function postReview(orgId: string, packName: string, input: { rating: number; body?: string }): Promise<Review> {
  const res = await fetch(
    `${base}/orgs/${encodeURIComponent(orgId)}/listings/${encodeURIComponent(packName)}/reviews`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }),
  );
  return asJson<Review>(res, 'postReview');
}

export async function deleteReview(orgId: string, packName: string, reviewId: string): Promise<void> {
  const res = await fetch(
    `${base}/orgs/${encodeURIComponent(orgId)}/listings/${encodeURIComponent(packName)}/reviews/${encodeURIComponent(reviewId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok && res.status !== 204) throw new Error(`deleteReview returned ${res.status}`);
}

// ── ADR 0366 P3/P4: feature-bundle catalog (read-only — the bundle shop) ──

export interface BundleFeatureInfo {
  id: string;
  label?: string;
  description?: string;
  /** The feature's toggle category ("grouping"), when declared. */
  category?: string;
  /** Hard dependencies — the shop closes these over the operator's selection. */
  dependsOn: string[];
  /** False when this build does not register the feature (slim distribution). */
  registered: boolean;
}

export interface FeatureBundleInfo {
  id: string;
  label: string;
  features: BundleFeatureInfo[];
}

export interface FeatureBundleCatalog {
  available: boolean;
  bundles: FeatureBundleInfo[];
  /** Non-core, non-bundled features — individually selectable (P4). */
  standalone: BundleFeatureInfo[];
  /** The always-included substrate — read-only (P4). */
  core: BundleFeatureInfo[];
}

export async function fetchFeatureBundles(): Promise<FeatureBundleCatalog> {
  const res = await fetch(`${base}/feature-bundles`, fetchOpts({ headers: authedHeaders() }));
  return asJson<FeatureBundleCatalog>(res, 'fetchFeatureBundles');
}

// ── ADR 0419 P2: the tenant bundle STORE (billing-owned; composed over HTTP,
// the ADR 0385 `purchaseListing` precedent — marketplace's own client hits the
// billing route, no cross-feature code import). No Stripe id crosses this boundary.

export interface BundleCommerce {
  bundleId: string;
  forSale: boolean;
  owned: boolean;
  priceDisplay?: { price?: string; cadence?: string; blurb?: string };
}

/** Per-bundle for-sale/owned/display for the caller's tenant. 404 when the
 *  billing feature is off ⇒ the caller treats it as "nothing for sale". */
export async function fetchBundleCommerce(): Promise<BundleCommerce[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/billing/bundles`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return [];
  return (await asJson<{ bundles: BundleCommerce[] }>(res, 'fetchBundleCommerce')).bundles;
}

/** Start a bundle purchase (platform→tenant, billing lane). The server resolves
 *  the configured price from the bundleId; returns the Stripe hosted-checkout URL
 *  (`mode:'live'`) or the honest demo sentinel (`mode:'demo'`). */
export async function buyBundle(bundleId: string): Promise<{ url: string; mode: 'live' | 'demo' }> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/billing/bundles/${encodeURIComponent(bundleId)}/checkout`,
    fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: '{}' }),
  );
  return asJson<{ url: string; mode: 'live' | 'demo' }>(res, 'buyBundle');
}
