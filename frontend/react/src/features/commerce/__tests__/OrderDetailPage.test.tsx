/**
 * ADR 0336 (deep-link program) / DL-T-1b — OrderDetailPage derives its target
 * from the route: `:orderId` (path param) + `?org=` (search). These pin the
 * deep-link-critical behavior: the fetch is keyed on the DERIVED (orgId,
 * orderId), a missing `?org=` fails closed to "not found" WITHOUT a fetch (no
 * existence leak / no undefined-arg call), a 404 renders not-found, and the
 * access-gate tri-state holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getOrder, listOrderRefunds } = vi.hoisted(() => ({ getOrder: vi.fn(), listOrderRefunds: vi.fn() }));
// Spread the REAL module so the product's `instanceof CommerceApiError` is the shipped
// class. The old fake took `(status)`; the real one is `(message, code, details?, status?)`.
vi.mock('../commerceClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrder, listOrderRefunds }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ date: (d: string) => d, currency: (n: number) => String(n) }) }));
// Spread the REAL module and override only the two components. Enumerating the
// exports made this mock silently incomplete the moment the shared module grew a
// helper (`orderChargeTotal`), which the page then called as `undefined` — the
// whole render threw and the failure read as "text not found".
vi.mock('../commerceShared.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  StatusChip: ({ value }: { value: string }) => <span>{value}</span>,
  OrderActions: () => <div data-testid="order-actions" />,
}));
const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => access.value }));

import { OrderDetailPage } from '../OrderDetailPage.js';
import { CommerceApiError, type Order } from '../commerceClient.js';

// Typed: `fulfillmentStatus: 'unfulfilled'` (not in the union) and a missing
// `createdBy` used to ride an untyped literal.
const anOrder: Order = {
  orderId: 'ord_1', status: 'paid', fulfillmentStatus: 'pending', createdAt: '2026-07-10', createdBy: 'user-1',
  currency: 'USD', items: [{ productId: 'p1', name: 'Widget', quantity: 2, unitPrice: 500 }],
  subtotal: 1000, discount: 0, total: 1000,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/commerce/orders/:orderId" element={<OrderDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  getOrder.mockReset(); listOrderRefunds.mockReset();
  access.value = { enabled: true, loading: false, variant: undefined };
  listOrderRefunds.mockResolvedValue([]);
});

describe('OrderDetailPage deep-link derivation (DL-T-1b)', () => {
  it('fetches the order keyed on the derived (orgId, orderId) and renders it', async () => {
    getOrder.mockResolvedValue(anOrder);
    renderAt('/commerce/orders/ord_1?org=store_9');
    await waitFor(() => expect(getOrder).toHaveBeenCalledWith('store_9', 'ord_1'));
    expect(await screen.findByText('ord_1')).toBeTruthy();
  });

  it('fails closed to not-found (no fetch) when ?org= is absent', async () => {
    renderAt('/commerce/orders/ord_1');
    expect(await screen.findByText('orderNotFoundTitle')).toBeTruthy();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('renders not-found on a 404 (tenant-scoped miss, no existence leak)', async () => {
    getOrder.mockRejectedValue(new CommerceApiError('Order not found', 'not_found', undefined, 404));
    renderAt('/commerce/orders/ghost?org=store_9');
    expect(await screen.findByText('orderNotFoundTitle')).toBeTruthy();
    expect(getOrder).toHaveBeenCalledWith('store_9', 'ghost');
    expect(screen.queryByText('loadErrorTitle')).toBeNull();
  });

  it('shows the not-enabled gate when the feature is off', async () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderAt('/commerce/orders/ord_1?org=store_9');
    expect(await screen.findByText('notEnabledTitle')).toBeTruthy();
    expect(getOrder).not.toHaveBeenCalled();
  });
});
