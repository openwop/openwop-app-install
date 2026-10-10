/**
 * ADR 0391 (b) / ADR 0820 §7 — the two anonymous pricing reads, as the public
 * `/pricing` fallback's FAQ (`./pricingFaq.ts`) needs them. The tier
 * grid (`PricingSection`) keeps its own reads; the server sends
 * `Cache-Control: max-age=300`, so a repeat read is normally a browser-cache hit.
 * Concurrent calls share one in-flight request; nothing is cached after it
 * settles (a module cache would outlive a failed read and leak between tests).
 *
 * Billing owns every number here; the page bakes none in. No Stripe id crosses
 * this boundary (the server never sends one).
 */
import { config, fetchOpts } from '../../client/config.js';

export interface PriceDisplay { price?: string; cadence?: string; blurb?: string; priceAnnual?: string; cadenceAnnual?: string }
export interface PublicTier {
  tier: string;
  name: string;
  // '*' = unrestricted (all features) — the billing wire sentinel; NOT always an array.
  features?: '*' | string[];
  limits?: Record<string, unknown>;
  display?: PriceDisplay & { highlighted?: boolean; annualNote?: string };
  /** The checkout trial this tier is configured with (absent = none). */
  trialDays?: number;
}
export interface PublicBundle { bundleId: string; label: string; features?: string[]; standalone?: boolean; priceDisplay?: PriceDisplay }
export interface CreditPack { credits: number; price: string; label?: string }
/** Grace windows the FAQ states. `publicLapseGraceDays` null = policy OFF. */
export interface BillingPolicy { pastDueGraceDays: number; publicLapseGraceDays: number | null }
export interface PricingPayload { tiers: PublicTier[]; featureLabels: Record<string, string>; creditPacks: CreditPack[]; billingPolicy?: BillingPolicy }

function parsePolicy(raw: unknown): BillingPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { pastDueGraceDays?: unknown; publicLapseGraceDays?: unknown };
  if (typeof r.pastDueGraceDays !== 'number') return undefined;
  if (r.publicLapseGraceDays !== null && typeof r.publicLapseGraceDays !== 'number') return undefined;
  return { pastDueGraceDays: r.pastDueGraceDays, publicLapseGraceDays: r.publicLapseGraceDays };
}

let pricingInFlight: Promise<PricingPayload> | null = null;
/** `/public/pricing`, normalized. Rejects on a failed read (failed ≠ empty). */
export function loadPublicPricing(): Promise<PricingPayload> {
  if (!pricingInFlight) {
    pricingInFlight = fetch(`${config.baseUrl}/host/openwop-app/public/pricing`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as Partial<PricingPayload>; })
      .then((r): PricingPayload => {
        const billingPolicy = parsePolicy(r.billingPolicy);
        return {
          tiers: Array.isArray(r.tiers) ? r.tiers : [],
          featureLabels: r.featureLabels && typeof r.featureLabels === 'object' ? r.featureLabels : {},
          creditPacks: Array.isArray(r.creditPacks) ? r.creditPacks.filter((p) => p && typeof p.credits === 'number' && typeof p.price === 'string' && p.price) : [],
          ...(billingPolicy ? { billingPolicy } : {}),
        };
      })
      .finally(() => { pricingInFlight = null; });
  }
  return pricingInFlight;
}

let bundlesInFlight: Promise<PublicBundle[]> | null = null;
/** `/public/bundle-pricing` (ADR 0419). A 404 is genuinely unconfigured (`[]`);
 *  any other failure rejects (READ-1 — failed ≠ none configured). */
export function loadPublicBundlePricing(): Promise<PublicBundle[]> {
  if (!bundlesInFlight) {
    bundlesInFlight = fetch(`${config.baseUrl}/host/openwop-app/public/bundle-pricing`, fetchOpts({}))
      .then(async (r) => {
        if (r.status === 404) return [] as PublicBundle[];
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as { bundles?: unknown };
        return Array.isArray(body.bundles) ? (body.bundles as PublicBundle[]) : [];
      })
      .finally(() => { bundlesInFlight = null; });
  }
  return bundlesInFlight;
}
