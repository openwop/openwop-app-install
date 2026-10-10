/**
 * ADR 0419 §8 follow-on / ADR 0820 §7 — which bundle sells a locked feature, and
 * what the prompt may say about it. Everything comes from the three store reads;
 * a feature no bundle sells resolves to `null` (the caller keeps its old copy),
 * and an unpurchasable bundle carries no price and no plan line.
 *
 * Sabotage-witnessed (/grade-tests wave 10): dropping the `if (!purchasable) return
 * out` early return reds the unpurchasable case (its fixture now HAS a price and a
 * covering plan, so the early return is the only guard); dropping the cadence half
 * of `bundlePrice`'s `sellsYear` reds the yearly case; `catalogP ??=` → `=` and
 * `if (dataP)` → false red the session-cache case; not clearing a failed catalog /
 * store read reds the two retry cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BundleCommerce, FeatureBundleCatalog, PublicPlanTier } from '../marketplaceClient.js';

const api = vi.hoisted(() => ({ fetchFeatureBundles: vi.fn(), fetchBundleCommerce: vi.fn(), fetchPublicPricing: vi.fn() }));
vi.mock('../marketplaceClient.js', () => api);

import {
  __resetLockedUpsellCacheForTest, featureBundleIndex, loadUpsellData, resolveUpsell, type UpsellData,
} from '../lockedUpsell.js';

const f = (id: string) => ({ id, registered: true, dependsOn: [] });
const CATALOG: FeatureBundleCatalog = {
  available: true,
  bundles: [
    { id: 'leadership', label: 'Planning & Strategy', features: [f('okrs'), f('advisory-board')] },
    { id: 'studio', label: 'Studio', features: [f('slides')] },
    { id: 'canvases', label: 'Canvases', features: [f('drawings')] },
    { id: 'agents', label: 'Agents', features: [f('agent-teams')] },
    { id: 'crm', label: 'CRM', features: [f('crm')] },
  ],
  standalone: [],
  core: [f('chat')],
};
const sale = (bundleId: string, price: string, annual?: string): BundleCommerce => ({
  bundleId, forSale: true, owned: false, purchasable: true, cadences: annual ? ['month', 'year'] : ['month'],
  priceDisplay: { price, cadence: '/mo', blurb: `${bundleId} blurb`, ...(annual ? { priceAnnual: annual, cadenceAnnual: '/yr' } : {}) },
});
const COMMERCE: BundleCommerce[] = [
  sale('leadership', '$19', '$190'), sale('studio', '$15'), sale('canvases', '$12'), sale('agents', '$15'),
  { bundleId: 'crm', forSale: false, owned: false },
];
const PRO: PublicPlanTier = {
  tier: 'pro', name: 'Pro', limits: {},
  features: ['bundle:leadership', 'bundle:studio', 'bundle:canvases', 'bundle:agents'],
  display: { price: '$39', cadence: '/mo' },
};
const FREE: PublicPlanTier = { tier: 'free', name: 'Free', limits: {}, features: ['chat'], display: { price: '$0' } };
const data = (over: Partial<UpsellData> = {}): UpsellData => ({ catalog: CATALOG, commerce: COMMERCE, plans: [FREE, PRO], ...over });

beforeEach(() => {
  __resetLockedUpsellCacheForTest();
  api.fetchFeatureBundles.mockReset().mockResolvedValue(CATALOG);
  api.fetchBundleCommerce.mockReset().mockResolvedValue(COMMERCE);
  api.fetchPublicPricing.mockReset().mockResolvedValue([FREE, PRO]);
});

describe('resolveUpsell', () => {
  it('names the owning bundle with its value line, monthly and yearly price', () => {
    const u = resolveUpsell('advisory-board', data());
    expect(u?.bundle.id).toBe('leadership');
    expect(u).toMatchObject({ purchasable: true, blurb: 'leadership blurb', monthly: '$19/mo', yearly: '$190/yr' });
  });

  it('offers a plan only when it is computably cheaper than the bundles it includes', () => {
    // Pro $39 covers four bundles worth $61/mo → the better buy.
    expect(resolveUpsell('okrs', data())?.plan).toEqual({ name: 'Pro', price: '$39/mo', bundles: 4 });
    // Pro at $99 is worth less than it costs → no plan line.
    const dear = { ...PRO, display: { price: '$99', cadence: '/mo' } };
    expect(resolveUpsell('okrs', data({ plans: [FREE, dear] }))?.plan).toBeUndefined();
    // An unparseable plan price → nothing computable → no line.
    const vague = { ...PRO, display: { price: 'Contact us' } };
    expect(resolveUpsell('okrs', data({ plans: [vague] }))?.plan).toBeUndefined();
  });

  it('an unpurchasable bundle carries no price and no plan — never a fabricated figure', () => {
    // The not-for-sale row still PUBLISHES a price, and a plan covers it: only the
    // purchasable gate stands between this data and a figure on the prompt.
    const commerce: BundleCommerce[] = [
      ...COMMERCE.filter((c) => c.bundleId !== 'crm'),
      { bundleId: 'crm', forSale: false, owned: false, priceDisplay: { price: '$9', cadence: '/mo', blurb: 'crm blurb' } },
    ];
    const crmPlan: PublicPlanTier = { ...PRO, features: [...PRO.features, 'bundle:crm'] };
    const u = resolveUpsell('crm', data({ commerce, plans: [FREE, crmPlan] }));
    expect(u?.bundle.id).toBe('crm');
    expect(u?.purchasable).toBe(false);
    expect(u?.monthly).toBeUndefined();
    expect(u?.yearly).toBeUndefined();
    expect(u?.plan).toBeUndefined();
    // The value line is copy, not a price — it is kept.
    expect(u?.blurb).toBe('crm blurb');
  });

  it('a store that could not be read (empty commerce) is not purchasable', () => {
    expect(resolveUpsell('okrs', data({ commerce: [] }))?.purchasable).toBe(false);
  });

  it('shows no yearly price unless the bundle sells yearly with a published amount', () => {
    expect(resolveUpsell('slides', data())).toMatchObject({ monthly: '$15/mo' });
    expect(resolveUpsell('slides', data())?.yearly).toBeUndefined();
    // A published yearly amount is not enough: the bundle must also SELL yearly.
    const monthOnly: BundleCommerce = { ...sale('studio', '$15', '$150'), cadences: ['month'] };
    const commerce = [...COMMERCE.filter((c) => c.bundleId !== 'studio'), monthOnly];
    expect(resolveUpsell('slides', data({ commerce }))).toMatchObject({ monthly: '$15/mo' });
    expect(resolveUpsell('slides', data({ commerce }))?.yearly).toBeUndefined();
  });

  it('a feature in NO bundle resolves to null (the caller keeps the generic copy)', () => {
    expect(resolveUpsell('chat', data())).toBeNull();
    expect(resolveUpsell('not-a-feature', data())).toBeNull();
  });
});

describe('session cache — one fetch for N locked surfaces', () => {
  it('N callers share one read of each endpoint', async () => {
    await Promise.all([loadUpsellData(), loadUpsellData(), loadUpsellData(), featureBundleIndex()]);
    await loadUpsellData();
    expect(api.fetchFeatureBundles).toHaveBeenCalledTimes(1);
    expect(api.fetchBundleCommerce).toHaveBeenCalledTimes(1);
    expect(api.fetchPublicPricing).toHaveBeenCalledTimes(1);
  });

  it('the nav index maps every bundled feature to its bundle', async () => {
    const ix = await featureBundleIndex();
    expect(ix['advisory-board']).toEqual({ id: 'leadership', label: 'Planning & Strategy' });
    expect(ix.chat).toBeUndefined();
  });

  it('a failed read is not cached — the next caller retries', async () => {
    api.fetchFeatureBundles.mockRejectedValueOnce(new Error('offline'));
    await expect(loadUpsellData()).rejects.toThrow('offline');
    await expect(loadUpsellData()).resolves.toMatchObject({ catalog: CATALOG });
    expect(api.fetchFeatureBundles).toHaveBeenCalledTimes(2);
  });

  it('a failed STORE read is not pinned for the session either', async () => {
    api.fetchBundleCommerce.mockRejectedValueOnce(new Error('503'));
    expect((await loadUpsellData()).commerce).toEqual([]);
    expect((await loadUpsellData()).commerce).toEqual(COMMERCE);
    expect(api.fetchBundleCommerce).toHaveBeenCalledTimes(2);
    expect(api.fetchFeatureBundles).toHaveBeenCalledTimes(1);
  });
});
