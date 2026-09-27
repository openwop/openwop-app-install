/**
 * MKT-UX-5 — a purchase creates a durable `status:'pending'` order, and (until this
 * fix) NO catalog card rendered it: between checkout and the fulfilment webhook, and
 * after a failed payment, a card was identical to never having tried. This asserts
 * the card now distinguishes pending / failed / never-attempted, and disables Buy
 * while a purchase is pending (so it can't be double-started).
 *
 * Born red pre-fix: `listMyOrders` did not exist, `MarketplacePage` never read the
 * caller's orders, and PricingChip had no pending/failed state — the payment chips
 * below rendered nothing and Buy was always enabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EffectiveAccess } from '../../../client/accessClient.js';

const api = vi.hoisted(() => ({
  listListings: vi.fn(),
  fetchDisabledPacks: vi.fn(),
  listOrgs: vi.fn(),
  getPurchaseOrder: vi.fn(),
  purchaseListing: vi.fn(),
  listMyOrders: vi.fn(),
}));
const access = vi.hoisted(() => ({ current: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' } as EffectiveAccess }));

vi.mock('../marketplaceClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() }, Toaster: () => null }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>()),
  useEffectiveAccess: () => access.current,
}));

import { MarketplacePage } from '../MarketplacePage.js';

const PAID = {
  packName: 'vendor.paid.nodes', version: '1.0.0', title: 'Paid Pack', category: 'nodes',
  installed: false, origin: 'registry' as const,
  pricing: { lane: 'native-paid' as const, priceMajorUnits: 99, currency: 'usd', purchasable: true },
};
const order = (status: string) => ({
  orderId: 'o1', packName: 'vendor.paid.nodes', amountMajorUnits: 99, currency: 'usd',
  applicationFeeMajorUnits: 5, status, mode: 'demo' as const, createdAt: '2026-06-22T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listListings.mockResolvedValue({ listings: [PAID], pricingDegraded: false });
  api.fetchDisabledPacks.mockResolvedValue([]);
  api.listOrgs.mockResolvedValue([]);
  api.listMyOrders.mockResolvedValue({ purchases: [], sales: [] });
});
afterEach(cleanup);

const at = () => render(<MemoryRouter initialEntries={['/marketplace']}><MarketplacePage /></MemoryRouter>);

describe('MKT-UX-5 — a pending/failed order is distinguishable on the card', () => {
  it('NO order: price chip, Buy enabled (the control — never-attempted)', async () => {
    at();
    const buy = await screen.findByRole('button', { name: /^buy$/i });
    expect((buy as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/payment pending/i)).toBeNull();
    expect(screen.queryByText(/payment failed/i)).toBeNull();
  });

  it('a PENDING order: "Payment pending" chip AND Buy is disabled (can\'t double-start)', async () => {
    api.listMyOrders.mockResolvedValue({ purchases: [order('pending')], sales: [] });
    at();
    await waitFor(() => expect(screen.getByText(/payment pending/i)).toBeTruthy());
    const buy = screen.getByRole('button', { name: /^buy$/i });
    expect((buy as HTMLButtonElement).disabled).toBe(true);
  });

  it('a FAILED order: "Payment failed" chip, Buy stays ENABLED (retry)', async () => {
    api.listMyOrders.mockResolvedValue({ purchases: [order('failed')], sales: [] });
    at();
    await waitFor(() => expect(screen.getByText(/payment failed/i)).toBeTruthy());
    const buy = screen.getByRole('button', { name: /^buy$/i });
    expect((buy as HTMLButtonElement).disabled).toBe(false);
  });

  it('a DEMO purchase refreshes the card to "Payment pending" + disabled Buy, no reload', async () => {
    // Finding-1 regression: the demo lane writes a durable pending order; the card
    // must engage IN-SESSION (the deployed host has no Stripe key, so every purchase
    // is demo). listMyOrders returns [] first, then the pending order after `load()`.
    api.purchaseListing.mockResolvedValue({ order: order('pending'), url: 'demo:checkout:x', mode: 'demo' });
    api.listMyOrders.mockResolvedValueOnce({ purchases: [], sales: [] }).mockResolvedValue({ purchases: [order('pending')], sales: [] });
    at();
    const buy = await screen.findByRole('button', { name: /^buy$/i });
    expect((buy as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buy);
    await waitFor(() => expect(screen.getByText(/payment pending/i)).toBeTruthy());
    expect((screen.getByRole('button', { name: /^buy$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an unreadable order list fabricates no state (empty ⇒ no payment chip)', async () => {
    api.listMyOrders.mockResolvedValue({ purchases: [], sales: [] }); // the client returns [] on a read failure
    at();
    await waitFor(() => expect(screen.getByText('vendor.paid.nodes')).toBeTruthy());
    expect(screen.queryByText(/payment pending/i)).toBeNull();
    expect(screen.queryByText(/payment failed/i)).toBeNull();
  });
});
