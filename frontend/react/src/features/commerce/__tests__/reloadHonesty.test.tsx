/**
 * CM-R2-1 / CM-R2-2 (commerce round 2) — reload-after-failure honesty.
 *
 * The quotes section had the correct reload shape; products and orders
 * reloads regressed it: `.catch(() => setProducts([]))` meant clicking RETRY
 * on a failed load flattened a STILL-failing read into the "no products"
 * empty state — a false recovery. And a failed orgs read rendered the
 * no-orgs claim (the session's recurring shape).
 *
 * The retry-path pin: with the API still failing, retry must KEEP the error
 * card (old code showed the empty state). Recovery polarity: a succeeding
 * retry shows the real rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listProducts: vi.fn(), listOrders: vi.fn(),
  listQuotes: vi.fn(), listProductFields: vi.fn(), listPriceLists: vi.fn(),
  listCoupons: vi.fn(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../commerceClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, useFeatureAccess: access.useFeatureAccess };
});

import { CommercePage } from '../CommercePage.js';

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listProducts.mockRejectedValue(new Error('products_500'));
  api.listOrders.mockResolvedValue([]);
  api.listQuotes.mockResolvedValue([]);
  api.listProductFields.mockResolvedValue([]);
  api.listPriceLists.mockResolvedValue([]);
  api.listCoupons.mockResolvedValue([]);
});
afterEach(cleanup);

describe('CM-R2-2 — products retry keeps the error card while the read still fails', () => {
  it('failing retry stays on the error card (never the empty state); success recovers', async () => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    const retry = await screen.findByRole('button', { name: /retry/i });
    // Still failing → the card must SURVIVE the retry (old code flattened to
    // the "no products" empty state here — a false recovery).
    fireEvent.click(retry);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
    // Recovery polarity: a succeeding retry shows real rows.
    api.listProducts.mockResolvedValue([{ productId: 'p1', name: 'Widget', priceMinor: 100, currency: 'USD', status: 'active' }]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Widget')).toBeTruthy();
  });
});

describe('CM-R2-1 — a failed orgs read never claims "no orgs"', () => {
  it('shows the error card instead of the no-orgs invitation', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    // `ui/OrgSelectionState` owns this card now: the shared failure title plus
    // THIS feature's consequence clause. The empty-state title must stay absent.
    const cards = await screen.findAllByText('Could not load your organizations');
    expect(cards.length).toBeGreaterThan(0);
    expect(screen.getByText(/product catalog was never requested/i)).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});

/**
 * Sentinel triage 2026-08-03 — the coupons read had the same shape the products
 * read was fixed for: `.catch(() => setCoupons([]))` landed a FAILED read in the
 * "No coupons yet." branch, asserting an empty catalog we never actually read.
 * Both polarities, since the "absent" arm alone is vacuous.
 */
describe('coupons — a failed read is not an empty catalog', () => {
  // Coupons live in the Pricing TAB, which is not the landing tab.
  const openPricing = async (): Promise<void> => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Pricing' }));
  };

  it('read FAILS: the failure is stated; "No coupons yet." is NOT', async () => {
    api.listCoupons.mockRejectedValue(new Error('coupons_500'));
    await openPricing();
    expect(await screen.findByText(/failed read, not an empty catalog/i)).toBeTruthy();
    expect(screen.queryByText('No coupons yet.')).toBeNull();
  });

  it('read SUCCEEDS with none: the real "No coupons yet." survives', async () => {
    api.listCoupons.mockResolvedValue([]);
    await openPricing();
    expect(await screen.findByText('No coupons yet.')).toBeTruthy();
    expect(screen.queryByText(/failed read, not an empty catalog/i)).toBeNull();
  });
});
