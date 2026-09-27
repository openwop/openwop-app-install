/**
 * Listing-pricing hook (ADR 0385 Phase 4) — the dependency-safe seam by which
 * COMMERCE-CONNECT annotates marketplace listings with paid-lane pricing,
 * WITHOUT marketplace importing commerce-connect (the `connectEventHook` /
 * `subscriptionInvoiceHook` inversion). Marketplace OWNS + fires it from its
 * routes; commerce-connect registers the provider at boot. Default = no-op ⇒
 * listings are byte-identical when the feature is absent/OFF.
 */

/** Optional pricing annotation on a computed Listing (additive projection). */
export interface ListingPricing {
  lane: 'free' | 'external-link' | 'native-paid';
  priceMajorUnits?: number;
  currency?: string;
  externalPaymentUrl?: string;
  /** Native-paid only: purchasable state for THIS viewer tenant. */
  purchasable?: boolean;
  /** Native-paid only: the viewer tenant already holds a paid order. */
  purchased?: boolean;
}

type ListingPricingProvider = (
  packNames: string[],
  viewerTenantId: string,
) => Promise<Record<string, ListingPricing>>;

let provider: ListingPricingProvider | null = null;

/** commerce-connect registers its pricing provider here at boot. */
export function setListingPricingProvider(fn: ListingPricingProvider | null): void { provider = fn; }

/** Called by marketplace routes to annotate a page of listings. Never throws
 *  into the browse path — pricing is an enrichment, not a gate.
 *
 *  MKT2-M1 (R3) — the enrichment posture was right; the SILENCE was not: a
 *  failed provider returned bare `{}`, so a PAID pack rendered pixel-identical
 *  to a free one with no purchase path and nothing said (a money-signalled
 *  surface). The failure is now DISCLOSED via `degraded` so the route can tell
 *  the client "pricing is unavailable", never "everything is free". */
export async function resolveListingPricing(packNames: string[], viewerTenantId: string): Promise<{ pricing: Record<string, ListingPricing>; degraded: boolean }> {
  if (!provider || packNames.length === 0) return { pricing: {}, degraded: false };
  try { return { pricing: await provider(packNames, viewerTenantId), degraded: false }; } catch { return { pricing: {}, degraded: true }; }
}
