/**
 * UX_UPGRADE-marketplace ROUND 3 — MKT2-M1.
 *
 * `resolveListingPricing`'s catch returned bare `{}`, so a PAID pack rendered
 * pixel-identical to a free one with no purchase path and nothing said — on a
 * money-signalled surface. The enrichment posture (never a gate) stands; the
 * failure is now DISCLOSED (`degraded`) so the route can add `pricingDegraded`
 * and the client can say "pricing unavailable", never "everything is free".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveListingPricing, setListingPricingProvider } from '../src/features/marketplace/listingPricingHook.js';

afterEach(() => setListingPricingProvider(null));

describe('MKT2-M1 — a failed pricing enrichment is disclosed, never silent freeness', () => {
  it('a throwing provider yields empty pricing WITH degraded: true', async () => {
    setListingPricingProvider(async () => { throw new Error('commerce down'); });
    const out = await resolveListingPricing(['pack.a'], 'tenant-1');
    expect(out.pricing).toEqual({});
    expect(out.degraded).toBe(true);
  });

  it('a healthy provider is NOT degraded; no provider is NOT degraded (enrichment absent ≠ failed)', async () => {
    setListingPricingProvider(async () => ({ 'pack.a': { kind: 'external-link', url: 'https://x' } } as never));
    const healthy = await resolveListingPricing(['pack.a'], 'tenant-1');
    expect(healthy.degraded).toBe(false);
    expect(Object.keys(healthy.pricing)).toContain('pack.a');
    setListingPricingProvider(null);
    const none = await resolveListingPricing(['pack.a'], 'tenant-1');
    expect(none).toEqual({ pricing: {}, degraded: false });
  });
});
