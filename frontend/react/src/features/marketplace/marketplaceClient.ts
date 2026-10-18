/**
 * Marketplace feature client (host-extension, non-normative — ADR 0022). Wraps
 * /host/openwop-app/marketplace/*. 404s when the `marketplace` toggle is off; the
 * install route additionally 403s for a non-superadmin caller (surfaced as a clear
 * message). Reviews are org-scoped (`/orgs/:orgId/listings/:packName/reviews`).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { ApiError } from '../../client/errorEnvelope.js';

export interface Listing {
  packName: string;
  version: string;
  title: string;
  description?: string;
  author?: string;
  category: string;
  /** Present only while the install still verifies (`trust.tier` is
   *  `operator-trusted`) — ADR 0826 D6. */
  integrity?: string;
  publicKeyRef?: string;
  /** A registry install marker is PRESENT. Not a verification claim — `trust` is. */
  installed: boolean;
  /** ADR 0826 D6 — the server's trust verdict (the ONE authority on whether the
   *  pack's code may run): `steward` ships with this app, `operator-trusted` is a
   *  signature-verified registry install, `untrusted` is unverified, `revoked` is
   *  kill-switched. Optional for older servers. */
  trust?: { tier: PackTrustTier; reason: string };
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

export type PackTrustTier = 'steward' | 'operator-trusted' | 'untrusted' | 'revoked';

/** ADR 0826 D1 — what THIS caller may do, computed server-side by the same
 *  predicates the write routes enforce. Presentation only; the server decides. */
export interface MarketplaceViewer {
  /** May change the workspace's pack availability (`workspace:write`). */
  canCurate: boolean;
  /** May install, remove, restore, purge and revoke (host operator). */
  canAdminister: boolean;
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
    // Typed (an `Error` subclass, same message): a caller can branch on the HTTP
    // status — the store tells a signed-out visitor (401) apart from a failure.
    throw new ApiError(detail || `${ctx} returned ${res.status}`, res.status, detail || undefined);
  }
  return (await res.json()) as T;
}

/** MKT2-M1 (R3) — `pricingDegraded` is the server's disclosure that the pricing
 *  enrichment FAILED: paid packs may be missing their purchase affordances, and
 *  the page must say so rather than render them as free. */
export async function listListings(): Promise<{ listings: Listing[]; pricingDegraded: boolean; viewer: MarketplaceViewer | null }> {
  const res = await fetch(`${base}/listings`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ listings: Listing[]; pricingDegraded?: boolean; viewer?: MarketplaceViewer }>(res, 'listListings');
  // `null` = an older server that does not say; the page then keeps offering every
  // control and lets the server refuse (its pre-ADR-0826 behaviour).
  return { listings: body.listings, pricingDegraded: body.pricingDegraded === true, viewer: body.viewer ?? null };
}

/** One operator revocation (ADR 0826 D5). `version` is a SemVer or `*`. */
export interface PackRevocation {
  key: string;
  packName: string;
  version: string;
  revokedAt: string;
  revokedBy: string;
  reason: string;
}

/**
 * The revocations a "Lift revocation" on `listing` must delete: its exact version
 * and any `*` row. EMPTY means the pack is revoked by the server's STATIC config
 * list (`OPENWOP_TRUSTED_PACK_REVOCATIONS`), which no route can lift — the caller
 * must say so rather than report a lift that never happened (ADR 0826, grade-ux).
 */
export function revocationsCovering(listing: Pick<Listing, 'packName' | 'version'>, rows: readonly PackRevocation[]): PackRevocation[] {
  return rows.filter((r) => r.packName === listing.packName && (r.version === listing.version || r.version === '*'));
}

/** Every active revocation — superadmin only. */
export async function listRevocations(): Promise<PackRevocation[]> {
  const res = await fetch(`${base}/revocations`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 403) throw new Error(SUPERADMIN_HINT);
  return (await asJson<{ revocations: PackRevocation[] }>(res, 'listRevocations')).revocations;
}

/** Revoke a pack version (or `*`) on every instance — superadmin only. Returns
 *  the feature ids that pin the pack (what the revocation takes down). */
export async function revokePack(packName: string, version: string, reason: string): Promise<{ requiredBy: string[] }> {
  const res = await fetch(`${base}/packs/${encodeURIComponent(packName)}/revocations`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ version, reason }),
  }));
  if (res.status === 403) throw new Error(SUPERADMIN_HINT);
  const body = await asJson<{ requiredBy?: string[] }>(res, 'revokePack');
  return { requiredBy: body.requiredBy ?? [] };
}

/** Lift one revocation — superadmin only. */
export async function unrevokePack(packName: string, version: string): Promise<void> {
  const res = await fetch(`${base}/packs/${encodeURIComponent(packName)}/revocations/${encodeURIComponent(version)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (res.status === 403) throw new Error(SUPERADMIN_HINT);
  if (!res.ok) await asJson<unknown>(res, 'unrevokePack');
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
  /** ADR 0820 §7 UI — the store goal-group (one of the catalog's `groups`).
   *  Grouping is DATA from `distributions/bundles.json`; an older backend omits it. */
  group?: string;
  features: BundleFeatureInfo[];
}

/** ADR 0892 Phase B — where a bundle stands in the caller's workspace. `enabled`:
 *  on here; `available`: the plan covers it, so Enable will succeed; `locked`: a
 *  feature it needs is not covered by the plan (`missing`) or is switched off on
 *  the host (`killed`). */
export interface BundleActivation {
  status: 'enabled' | 'available' | 'locked';
  missing?: string[];
  killed?: string[];
}

export interface FeatureBundleCatalog {
  available: boolean;
  /** ADR 0820 §7 UI — the ordered store goal-group ids. Optional: an older backend omits it. */
  groups?: string[];
  bundles: FeatureBundleInfo[];
  /** Non-core, non-bundled features — individually selectable (P4). */
  standalone: BundleFeatureInfo[];
  /** The always-included substrate — read-only (P4). */
  core: BundleFeatureInfo[];
  /** ADR 0892 Phase B — per-bundle state for THIS workspace. Absent from an older
   *  backend, and when the server could not read it (`activationDegraded`). */
  activation?: Record<string, BundleActivation>;
  activationDegraded?: boolean;
  /** ADR 0892 Phase B D1 — may the caller turn bundles on/off here (computed by the
   *  same predicate the write routes enforce). */
  viewer?: { canManageBundles: boolean };
}

export async function fetchFeatureBundles(): Promise<FeatureBundleCatalog> {
  const res = await fetch(`${base}/feature-bundles`, fetchOpts({ headers: authedHeaders() }));
  return asJson<FeatureBundleCatalog>(res, 'fetchFeatureBundles');
}

/** The typed refusal of a bundle enable/disable (ADR 0892 Phase B): `ids` are the
 *  features it names (missing from the plan, killed, or still-dependent) and
 *  `bundles` the bundles that would grant the missing ones. */
export class BundleActivationError extends ApiError {
  readonly code: 'bundle_not_entitled' | 'feature_killed' | 'disable_blocked' | 'other';
  readonly ids: string[];
  readonly bundles: string[];
  constructor(message: string, status: number, code: BundleActivationError['code'], ids: string[], bundles: string[], serverMessage?: string) {
    super(message, status, serverMessage, code === 'other' ? undefined : code);
    this.name = 'BundleActivationError';
    this.code = code;
    this.ids = ids;
    this.bundles = bundles;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

async function bundleWrite(bundleId: string, action: 'enable' | 'disable'): Promise<{ bundleId: string; status: 'enabled' | 'available' }> {
  const res = await fetch(`${base}/feature-bundles/${encodeURIComponent(bundleId)}/${action}`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  if (res.ok) return (await res.json()) as { bundleId: string; status: 'enabled' | 'available' };
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; details?: Record<string, unknown> };
  const code = body.error === 'bundle_not_entitled' || body.error === 'feature_killed' || body.error === 'disable_blocked' ? body.error : 'other';
  const d = body.details ?? {};
  const ids = code === 'bundle_not_entitled' ? strings(d.missing) : code === 'feature_killed' ? strings(d.ids) : strings(d.dependents);
  throw new BundleActivationError(body.message || `${action}FeatureBundle returned ${res.status}`, res.status, code, ids, strings(d.bundles), body.message);
}

/** Turn a bundle ON for the caller's active workspace (workspace admin). */
export function enableFeatureBundle(bundleId: string): Promise<{ bundleId: string; status: 'enabled' | 'available' }> {
  return bundleWrite(bundleId, 'enable');
}

/** Turn a bundle OFF for the caller's active workspace. No data is deleted. */
export function disableFeatureBundle(bundleId: string): Promise<{ bundleId: string; status: 'enabled' | 'available' }> {
  return bundleWrite(bundleId, 'disable');
}

// ── ADR 0419 P2: the tenant bundle STORE (billing-owned; composed over HTTP,
// the ADR 0385 `purchaseListing` precedent — marketplace's own client hits the
// billing route, no cross-feature code import). No Stripe id crosses this boundary.

export interface BundleCommerce {
  bundleId: string;
  forSale: boolean;
  owned: boolean;
  /** ADR 0820 §5 — the workspace's plan already grants every feature of this bundle,
   *  so it is not sold (checkout would 409). Optional: an older backend omits it. */
  includedInPlan?: boolean;
  /** ADR 0820 §7 UI — priced, not owned, not plan-included, and usable today because
   *  no plan allowlist narrows it (the server computes it from the plan alone). */
  freeForNow?: boolean;
  /** ADR 0820 §7 UI — whether a checkout would be ACCEPTED (for sale, not owned, not
   *  covered by the plan list the server's 409 `bundle_included_in_plan` reads — the
   *  free plan's complimentary list included). The store offers Buy only when true.
   *  Optional: an older backend omits it (then the status decides, as before). */
  purchasable?: boolean;
  /** ADR 0820 §7 — the free trial THIS workspace's checkout would open with, when any. */
  trialDays?: number;
  /** ADR 0820 §7 — the billing intervals this bundle is for sale at. */
  cadences?: Array<'month' | 'year'>;
  priceDisplay?: { price?: string; cadence?: string; blurb?: string; priceAnnual?: string; cadenceAnnual?: string };
}

/** Per-bundle for-sale/owned/display for the caller's tenant. 404 when the
 *  billing feature is off ⇒ the caller treats it as "nothing for sale". */
export async function fetchBundleCommerce(): Promise<BundleCommerce[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/billing/bundles`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return [];
  return (await asJson<{ bundles: BundleCommerce[] }>(res, 'fetchBundleCommerce')).bundles;
}

/** ADR 0391 (b) / ADR 0820 §5 — one plan tier of the PUBLIC pricing read: the
 *  feature allowlist (`'*'` = unrestricted) and the operator's display copy. No
 *  Stripe id crosses this boundary. */
export interface PublicPlanTier {
  tier: 'free' | 'pro' | 'team' | 'enterprise';
  name: string;
  features: '*' | string[];
  limits: Record<string, number>;
  display?: { price?: string; cadence?: string; blurb?: string; highlighted?: boolean; priceAnnual?: string; cadenceAnnual?: string; annualNote?: string };
}

/** The public plan catalog (anonymous, works with billing off). */
export async function fetchPublicPricing(): Promise<PublicPlanTier[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/public/pricing`, fetchOpts({}));
  const body = await asJson<{ tiers?: PublicPlanTier[] }>(res, 'fetchPublicPricing');
  return Array.isArray(body.tiers) ? body.tiers : [];
}

// ADR 0786 — the bundle purchase moved to `features/billing/billingClient.ts`
// (`buyBundle`): billing owns the money route and its typed refusals.
