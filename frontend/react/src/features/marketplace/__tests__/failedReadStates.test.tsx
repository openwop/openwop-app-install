/**
 * UX_UPGRADE-marketplace ROUND 3 — MKT2-M1 (client half) + MKT2-M2.
 *
 *  - M1: when the server discloses `pricingDegraded`, the page warns that paid
 *    packs may be missing purchase options ("they are not free") — and never
 *    warns on a healthy read.
 *  - M2: a failed listings/catalog read used to render an error Notice above a
 *    PERMANENT skeleton with no retry. Failure is a designed state with retry
 *    on BOTH screens — and Retry LANDS on the real answer (the re-read state), not
 *    merely "the card went away", which a skeleton that never resolves satisfies.
 *
 * Sabotage-witnessed (/grade-tests wave 10): `{pricingDegraded ?` → false and
 * `setPricingDegraded(true)` red the two M1 polarities; dropping
 * `setListingsFailed(true)` or either Retry's onClick reds M2; `.then(setCatalog)`
 * → no-op reds the Bundle retry case. Every client read the pages make is mocked
 * (ADR 0661 — this file is no longer on the live-fetch allowlist).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listListings: vi.fn(), fetchDisabledPacks: vi.fn(), fetchFeatureBundles: vi.fn(),
  fetchBundleCommerce: vi.fn(), listReviews: vi.fn(), fetchPublicPricing: vi.fn(),
  listMyOrders: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../marketplaceClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...api,
}));
const useFeatureAccess = vi.hoisted(() => vi.fn());
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));
// ADR 0820 §7 UI — the store also reads the workspace's plan; keep it off the network.
vi.mock('../../billing/billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn().mockResolvedValue({ tenantId: 't', planTier: 'free', status: 'none' }),
  // ADR 0821 D7 — the store's credit-pack strip read (its own tests: creditPacks.test.tsx).
  getTokenPacks: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// ADR 0661 — the effective-access read is a live fetch otherwise.
const ACCESS = vi.hoisted((): EffectiveAccess => ({ roles: ['admin'], scopes: ['workspace:read', 'workspace:write'], basis: 'tenant-owner' }));
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/useEffectiveAccess.js')>()),
  useEffectiveAccess: () => ACCESS,
  useEffectiveAccessState: () => ({ access: ACCESS, resolved: true }),
}));

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';
import type { Listing } from '../marketplaceClient.js';
import { MarketplacePage } from '../MarketplacePage.js';
import { BundleShopPage } from '../BundleShopPage.js';

const ON = makeFeatureAccess({ enabled: true, loading: false });
const LISTING: Listing = { packName: 'pack.a', version: '1.0.0', title: 'Pack A', category: 'node', installed: false, origin: 'registry' };

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(ON);
  api.fetchDisabledPacks.mockResolvedValue([]);
  api.fetchBundleCommerce.mockResolvedValue([]);
  api.fetchPublicPricing.mockResolvedValue([]);
  api.listMyOrders.mockResolvedValue({ purchases: [], sales: [] });
  api.listOrgs.mockResolvedValue([]);
  api.listReviews.mockResolvedValue({ reviews: [], summary: { packName: 'pack.a', count: 0, average: null } });
});
afterEach(cleanup);

const mount = async (el: JSX.Element): Promise<void> => {
  render(<MemoryRouter>{el}</MemoryRouter>);
  await act(async () => {});
};

describe('MKT2-M1 — the pricing-degraded disclosure reaches the page', () => {
  it('warns when the server disclosed degradation, and names the truth ("not free")', async () => {
    api.listListings.mockResolvedValue({ listings: [LISTING], pricingDegraded: true });
    await mount(<MarketplacePage />);
    expect(await screen.findByText(/they are not free/i)).toBeTruthy();
  });

  it('never warns on a healthy read', async () => {
    api.listListings.mockResolvedValue({ listings: [LISTING], pricingDegraded: false });
    await mount(<MarketplacePage />);
    await screen.findByText('Pack A');
    expect(screen.queryByText(/they are not free/i)).toBeNull();
  });
});

describe('MKT2-M2 — failure is a designed state with retry, on both screens', () => {
  it('MarketplacePage: failed listings show the card; Retry re-reads to the real list', async () => {
    api.listListings.mockRejectedValueOnce(new Error('down'));
    api.listListings.mockResolvedValue({ listings: [LISTING], pricingDegraded: false });
    await mount(<MarketplacePage />);
    expect(await screen.findByText(/listings could not be loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Pack A')).toBeTruthy();
    expect(screen.queryByText(/listings could not be loaded/i)).toBeNull();
    expect(api.listListings).toHaveBeenCalledTimes(2);
  });

  it('BundleShopPage: failed catalog shows the card; Retry re-reads', async () => {
    api.fetchFeatureBundles.mockRejectedValueOnce(new Error('down'));
    api.fetchFeatureBundles.mockResolvedValue({ available: false, bundles: [] });
    await mount(<BundleShopPage />);
    expect(await screen.findByText(/bundles could not be loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    // Retry must LAND on the re-read answer ({available:false} → "No bundle catalog"),
    // not merely clear the card — a retry stuck on the skeleton also clears it.
    expect(await screen.findByText('No bundle catalog')).toBeTruthy();
    expect(screen.queryByText(/bundles could not be loaded/i)).toBeNull();
    expect(api.fetchFeatureBundles).toHaveBeenCalledTimes(2);
  });
});
