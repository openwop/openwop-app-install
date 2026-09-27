/**
 * UX_UPGRADE-marketplace ROUND 3 — MKT2-M1 (client half) + MKT2-M2.
 *
 *  - M1: when the server discloses `pricingDegraded`, the page warns that paid
 *    packs may be missing purchase options ("they are not free") — and never
 *    warns on a healthy read.
 *  - M2: a failed listings/catalog read used to render an error Notice above a
 *    PERMANENT skeleton with no retry. Failure is a designed state with retry
 *    on BOTH screens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listListings: vi.fn(), fetchDisabledPacks: vi.fn(), fetchFeatureBundles: vi.fn(),
  fetchBundleCommerce: vi.fn(), listReviews: vi.fn(),
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
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MarketplacePage } from '../MarketplacePage.js';
import { BundleShopPage } from '../BundleShopPage.js';

const ON = { status: 'on', enabled: true, isBeta: false, variant: null, entitled: true, locked: false, loading: false };
const LISTING = { packName: 'pack.a', version: '1.0.0', title: 'Pack A', category: 'node', installed: false };

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(ON);
  api.fetchDisabledPacks.mockResolvedValue([]);
  api.fetchBundleCommerce.mockResolvedValue([]);
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
  });

  it('BundleShopPage: failed catalog shows the card; Retry re-reads', async () => {
    api.fetchFeatureBundles.mockRejectedValueOnce(new Error('down'));
    api.fetchFeatureBundles.mockResolvedValue({ available: false, bundles: [] });
    await mount(<BundleShopPage />);
    expect(await screen.findByText(/bundles could not be loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/bundles could not be loaded/i)).toBeNull());
  });
});
