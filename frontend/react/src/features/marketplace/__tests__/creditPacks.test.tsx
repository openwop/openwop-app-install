/**
 * ADR 0821 D1/D7 — the store's "AI credits" strip (`CreditPacksStrip` on
 * `BundleShopPage`):
 *   - hidden when no pack is configured (and when billing is off);
 *   - a pack without a display `price` lists its credits but offers NO buy;
 *   - a caller without `host:billing:manage` sees the packs but NO buy
 *     (positive control: an admin is offered "Buy 1,000 credits · $5");
 *   - the buy sends the OPAQUE `packKey` — never a price — through the page's
 *     one-checkout-at-a-time path;
 *   - `?checkout=credits` (the pack's success return) toasts the credits copy.
 *
 * Sabotage-witnessed (/grade-tests wave 10): dropping the empty-packs guard, the
 * billing-off read guard, the `price` leg of the buy gate, the strip's `canBuy`,
 * the opaque `packKey`, the demo-copy toast or the credits return copy each red
 * their case. Honest ceiling: one-checkout-at-a-time is a DOUBLE guard (the strip
 * button's `disabled` + the page's `if (buying) return`) — breaking either alone
 * stays green; the double click below reds only when both break.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';
import type { TokenPack } from '../../billing/billingClient.js';
import type { BundleCommerce, FeatureBundleCatalog } from '../marketplaceClient.js';

const api = vi.hoisted(() => ({
  fetchFeatureBundles: vi.fn(), fetchBundleCommerce: vi.fn(), fetchPublicPricing: vi.fn(),
  buyBundle: vi.fn(), buyPlan: vi.fn(), getSubscription: vi.fn(), getTokenPacks: vi.fn(), buyCreditPack: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../marketplaceClient.js', () => ({
  fetchFeatureBundles: api.fetchFeatureBundles, fetchBundleCommerce: api.fetchBundleCommerce, fetchPublicPricing: api.fetchPublicPricing,
}));
vi.mock('../../billing/billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buyBundle: api.buyBundle, buyPlan: api.buyPlan, getSubscription: api.getSubscription,
  getTokenPacks: api.getTokenPacks, buyCreditPack: api.buyCreditPack,
}));
vi.mock('../../billing/AiCreditMeter.js', () => ({ AiCreditMeter: () => <div>AI credit meter (billing)</div> }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts, Toaster: () => null }));
const access = vi.hoisted(() => {
  const owner: EffectiveAccess = { basis: 'tenant-owner', roles: [], scopes: [] };
  return { current: { access: owner, resolved: true } };
});
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => access.current,
}));
let billingEnabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => {
    const on = id === 'billing' ? billingEnabled : true;
    return makeFeatureAccess({ enabled: on });
  },
}));
import { BundleShopPage } from '../BundleShopPage.js';

const CATALOG: FeatureBundleCatalog = {
  available: true, groups: [],
  bundles: [{ id: 'crm', label: 'CRM', features: [{ id: 'crm', label: 'Accounts', dependsOn: [], registered: true }] }],
  standalone: [], core: [],
};
const COMMERCE: BundleCommerce[] = [{ bundleId: 'crm', forSale: true, owned: false, includedInPlan: false, freeForNow: false, purchasable: true, cadences: ['month'], priceDisplay: { price: '$29', cadence: '/mo' } }];
const PACKS: TokenPack[] = [
  { packKey: 'pack_aaaaaaaaaaaaaaaa', credits: 1000, tokens: 1_000_000, priceDisplay: { price: '$5' } },
  { packKey: 'pack_bbbbbbbbbbbbbbbb', credits: 5000, tokens: 5_000_000, priceDisplay: { price: '$20', label: 'Popular' } },
  // No display copy ⇒ listed, never buyable.
  { packKey: 'pack_cccccccccccccccc', credits: 25000, tokens: 25_000_000 },
];

const page = (entry = '/marketplace/bundles') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/marketplace/bundles" element={<BundleShopPage />} /></Routes>
  </MemoryRouter>,
);
const strip = async (): Promise<HTMLElement> =>
  (await screen.findByRole('heading', { level: 2, name: 'AI credits' })).closest('section') as HTMLElement;

beforeEach(() => {
  billingEnabled = true;
  access.current = { access: { basis: 'tenant-owner', roles: [], scopes: [] }, resolved: true };
  api.fetchFeatureBundles.mockReset().mockResolvedValue(CATALOG);
  api.fetchBundleCommerce.mockReset().mockResolvedValue(COMMERCE);
  api.fetchPublicPricing.mockReset().mockResolvedValue([]);
  api.getSubscription.mockReset().mockResolvedValue({ tenantId: 't', planTier: 'free', status: 'none' });
  api.buyBundle.mockReset().mockResolvedValue({ url: 'demo:x', mode: 'demo' });
  api.buyPlan.mockReset().mockResolvedValue({ sessionId: 's', url: 'demo:x', mode: 'demo' });
  api.getTokenPacks.mockReset().mockResolvedValue(PACKS);
  api.buyCreditPack.mockReset().mockResolvedValue({ sessionId: 's', url: 'demo:x', mode: 'demo' });
  for (const f of Object.values(toasts)) f.mockReset();
});
afterEach(cleanup);

describe('AI credits strip (ADR 0821 D7)', () => {
  it('is hidden when no pack is configured (control: the store itself rendered)', async () => {
    api.getTokenPacks.mockResolvedValue([]);
    page();
    await screen.findByRole('heading', { level: 4, name: 'CRM' });
    await waitFor(() => expect(api.getTokenPacks).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'AI credits' })).toBeNull();
  });

  it('is hidden (and never read) with billing off', async () => {
    billingEnabled = false;
    page();
    await screen.findByRole('heading', { level: 4, name: 'CRM' });
    expect(api.getTokenPacks).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'AI credits' })).toBeNull();
  });

  it('an admin is offered "Buy 1,000 credits · $5"; a pack with no display price lists credits but has NO buy', async () => {
    page();
    const s = await strip();
    expect(within(s).getByText(/One-time packs that never expire/)).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'Buy 1,000 credits · $5' })).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'Buy 5,000 credits · $20' })).toBeTruthy();
    expect(within(s).getByText('Popular')).toBeTruthy();
    expect(within(s).getByText('25,000 credits')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: /25,000/ })).toBeNull();
    expect(within(s).getAllByRole('button')).toHaveLength(2);
  });

  it('a MEMBER without host:billing:manage sees the packs and their prices but no buy button', async () => {
    access.current = { access: { basis: 'member', roles: ['editor'], scopes: ['workspace:read', 'workspace:write'] }, resolved: true };
    page();
    const s = await strip();
    expect(within(s).getByText('1,000 credits')).toBeTruthy();
    expect(within(s).getByText('$5')).toBeTruthy();
    expect(within(s).queryAllByRole('button')).toHaveLength(0);
    expect(within(s).getByText('Only workspace owners and admins can buy credits.')).toBeTruthy();
  });

  it('buying sends the opaque packKey (never a price) and reports demo mode honestly', async () => {
    page();
    const s = await strip();
    const buy = within(s).getByRole('button', { name: 'Buy 5,000 credits · $20' });
    // A double click during the round trip must not open a second session.
    fireEvent.click(buy);
    fireEvent.click(buy);
    await waitFor(() => expect(api.buyCreditPack).toHaveBeenCalledWith('pack_bbbbbbbbbbbbbbbb'));
    expect(api.buyCreditPack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('Demo mode: no Stripe key is configured, so no real charge was made.'));
  });

  it('?checkout=credits (the pack success return) toasts the credits copy, not the bundle copy', async () => {
    page('/marketplace/bundles?checkout=credits');
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Payment received — your credits are added as soon as payment confirms.'));
  });
});
