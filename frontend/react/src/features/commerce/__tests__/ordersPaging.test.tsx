/**
 * ADR 1110 P5 — the Orders tab reads orders a page at a time, newest first: it says how
 * many of how many, "Load more" appends the next page, the status filter runs on the
 * server, and a full order id past the loaded pages is looked up directly.
 *
 * Sabotage, each restored, each red: Load more without the cursor; the status filter
 * applied in the browser; the order-id lookup skipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listProductsPage: vi.fn(), getProductsByIds: vi.fn(), listOrdersPage: vi.fn(),
  listQuotes: vi.fn(), listProductFields: vi.fn(), listPriceLists: vi.fn(),
  listCoupons: vi.fn(), getPaymentsReadiness: vi.fn(), getProductMedia: vi.fn(), getOrder: vi.fn(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../commerceClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useFeatureAccess: access.useFeatureAccess }));

import { CommercePage } from '../CommercePage.js';
import type { Order, Product } from '../commerceClient.js';

const product = (id: string, name: string): Product => ({ productId: id, type: 'physical', name, price: 1, currency: 'USD', variants: [], active: true, updatedAt: '2026-11-01T00:00:00.000Z' });

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listOrdersPage.mockResolvedValue({ orders: [] });
  api.listQuotes.mockResolvedValue([]);
  api.listProductFields.mockResolvedValue([]);
  api.listPriceLists.mockResolvedValue([]);
  api.listCoupons.mockResolvedValue([]);
  api.getPaymentsReadiness.mockResolvedValue({ settlement: 'platform', connectAvailable: false });
  api.getProductsByIds.mockResolvedValue([]);
  api.getProductMedia.mockResolvedValue([]); // the editor's photo panel
  api.listProductsPage.mockImplementation(async (_org: string, q: { cursor?: string; q?: string }) => {
    if (q.cursor === 'c1') return { products: [product('p3', 'Gamma')] };
    if (q.q) return { products: [product('p9', `Match ${q.q}`)] };
    return { products: [product('p1', 'Alpha'), product('p2', 'Beta')], nextCursor: 'c1', total: 120 };
  });
});
afterEach(cleanup);

const order = (id: string, status: Order['status'] = 'pending'): Order => ({
  orderId: id, items: [], subtotal: 5, discount: 0, total: 5, currency: 'USD', status, fulfillmentStatus: 'pending', createdBy: 'u', createdAt: '2026-11-01T00:00:00.000Z',
} as Order);
const ID = 'ord:12345678-1234-1234-1234-123456789abc';

describe('ADR 1110 P5 — the Orders tab pages orders', () => {
  beforeEach(() => {
    api.listProductsPage.mockResolvedValue({ products: [] });
    api.listOrdersPage.mockImplementation(async (_org: string, q: { cursor?: string; status?: string }) => {
      if (q.cursor === 'o1') return { orders: [order('ord:c')] };
      if (q.status) return { orders: [order('ord:paid', 'paid')] };
      return { orders: [order('ord:a'), order('ord:b')], nextCursor: 'o1', total: 9 };
    });
  });
  const openOrders = async (): Promise<void> => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: /orders/i }));
  };

  it('says how many of how many, and Load more appends', async () => {
    await openOrders();
    expect(await screen.findByText('Showing 2 of 9 orders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('ord:c')).toBeTruthy();
    expect(api.listOrdersPage).toHaveBeenLastCalledWith('o1', expect.objectContaining({ cursor: 'o1' }));
    expect(screen.getByText('ord:a')).toBeTruthy();
  });

  it('the status filter runs on the server', async () => {
    await openOrders();
    await screen.findByText('ord:a');
    fireEvent.change(screen.getByRole('combobox', { name: /status/i }), { target: { value: 'paid' } });
    expect(await screen.findByText('ord:paid')).toBeTruthy();
    expect(api.listOrdersPage).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'paid' }));
  });

  it('a full order id past the loaded pages is looked up directly', async () => {
    api.getOrder.mockResolvedValue(order(ID));
    await openOrders();
    await screen.findByText('ord:a');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ID } });
    expect(await screen.findByText(ID)).toBeTruthy();
    expect(api.getOrder).toHaveBeenCalledWith('o1', ID);
  });
});
