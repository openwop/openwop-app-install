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
 *
 * Sabotage-witnessed (re-probed wave 120, after ADR 1110 moved both lists to
 * paged reads): a retry whose failure no longer sets the error flag, a retry
 * that keeps the stale list (products and orders each), a success that drops
 * its rows, the shared hook flattening a failed orgs read to `[]`, the orgs
 * failure card losing this feature's clause, and the coupons failure flag
 * (dropped, or raised on a good read) each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as CC from '../commerceClient.js';
import type { OrderPage, ProductPage } from '../commerceClient.js';

// Typed against the real client (ADR 1110 P2/P5 moved both lists to paged reads),
// so a fixture in the old bare-array shape is a type error, not a silent pass.
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof CC.listOrgs>(), listProductsPage: vi.fn<typeof CC.listProductsPage>(), listOrdersPage: vi.fn<typeof CC.listOrdersPage>(),
  listQuotes: vi.fn<typeof CC.listQuotes>(), listProductFields: vi.fn<typeof CC.listProductFields>(), listPriceLists: vi.fn<typeof CC.listPriceLists>(),
  listCoupons: vi.fn<typeof CC.listCoupons>(), getPaymentsReadiness: vi.fn<typeof CC.getPaymentsReadiness>(),
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
import type { Product } from '../commerceClient.js';

/** The loading placeholder `ui/Skeleton` renders (aria-hidden, so it has no role). */
const skeletons = (): number => document.querySelectorAll('.skeleton').length;

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listProductsPage.mockRejectedValue(new Error('products_500'));
  api.listOrdersPage.mockResolvedValue({ orders: [] });
  api.listQuotes.mockResolvedValue([]);
  api.listProductFields.mockResolvedValue([]);
  api.listPriceLists.mockResolvedValue([]);
  api.listCoupons.mockResolvedValue([]);
  api.getPaymentsReadiness.mockResolvedValue({ settlement: 'platform', connectAvailable: false }); // ADR 0877 D6
});
afterEach(cleanup);

describe('CM-R2-2 — products retry keeps the error card while the read still fails', () => {
  it('failing retry stays on the error card (never the empty state); success recovers', async () => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    const retry = await screen.findByRole('button', { name: /retry/i });
    const before = skeletons();
    // Still failing → the card must SURVIVE the retry (old code flattened to
    // the "no products" empty state here — a false recovery).
    fireEvent.click(retry);
    // Settle on a signal both outcomes share: the retry's skeleton came and went,
    // so the second read has answered. Then the card is a VALUE check (one Retry,
    // no empty state), not a lookup that can only time out.
    await waitFor(() => expect(skeletons()).toBe(before));
    expect(screen.queryAllByRole('button', { name: /retry/i })).toHaveLength(1);
    expect(screen.queryByText('No products yet')).toBeNull();
    // Recovery polarity: a succeeding retry shows real rows.
    const widget: Product = { productId: 'p1', type: 'physical', name: 'Widget', price: 1, currency: 'USD', variants: [], active: true, updatedAt: '2026-07-01T00:00:00.000Z' };
    api.listProductsPage.mockResolvedValue({ products: [widget] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Widget')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('CM-R2-2-WINDOW — a retry in flight is not an empty catalog', () => {
  it('products: while the retry is pending, "No products" is not shown over the failed read', async () => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    const retry = await screen.findByRole('button', { name: /retry/i });
    api.listProductsPage.mockReturnValue(new Promise<ProductPage>(() => {}));
    const before = skeletons();
    fireEvent.click(retry);
    // Positive: the in-flight retry IS the loading state…
    expect(skeletons()).toBeGreaterThan(before);
    // …and never the empty catalog over a read that failed.
    expect(screen.queryByText('No products yet')).toBeNull();
    expect(screen.queryByText(/no products/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('orders: while the retry is pending, "No orders" is not shown over the failed read', async () => {
    api.listProductsPage.mockResolvedValue({ products: [] });
    api.listOrdersPage.mockRejectedValue(new Error('orders_500'));
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: /orders/i }));
    const retry = await screen.findByRole('button', { name: /retry/i });
    api.listOrdersPage.mockReturnValue(new Promise<OrderPage>(() => {}));
    const before = skeletons();
    fireEvent.click(retry);
    expect(skeletons()).toBeGreaterThan(before);
    expect(screen.queryByText('No orders yet')).toBeNull();
    expect(screen.queryByText(/no orders/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('CM-R2-1 — a failed orgs read never claims "no orgs"', () => {
  it('shows the error card instead of the no-orgs invitation', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    // `ui/OrgSelectionState` owns this card now: the shared failure title plus
    // THIS feature's consequence clause. The empty-state title must stay absent.
    const cards = await screen.findAllByText('Could not load your organizations');
    expect(cards).toHaveLength(1);
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
