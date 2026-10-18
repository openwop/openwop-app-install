/**
 * UX_UPGRADE-commerce — COM-G1 / COM-G2 / COM-G3.
 *
 *  - COM-G1: `Order.total` is goods-after-discount. The amount actually billed is
 *    `total + tax + shipping` — the type's own docblock says the Stripe charge
 *    bills `orderChargeTotal`. The summary rendered `total` in bold BELOW the tax
 *    and shipping lines: a number nobody paid, in the one position every invoice
 *    reserves for the grand total.
 *  - COM-G2: the full refund confirmed; the partial refund fired straight from a
 *    click or a stray Enter, with no ceiling shown (the backend rejects an
 *    over-refund, so the operator typed blind into a rejection).
 *  - COM-G3: a failed refunds read rendered exactly like "no refunds" — on a page
 *    that may simultaneously show a non-zero refunded amount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Order } from '../commerceClient.js';

const getOrder = vi.fn();
const listOrderRefunds = vi.fn();
const partialRefundOrder = vi.fn();
const confirmMock = vi.fn();

vi.mock('../commerceClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrder: (...a: unknown[]) => getOrder(...a),
  listOrderRefunds: (...a: unknown[]) => listOrderRefunds(...a),
  partialRefundOrder: (...a: unknown[]) => partialRefundOrder(...a),
  refundOrder: vi.fn(async () => ({})),
  payOrder: vi.fn(async () => ({})),
  cancelOrder: vi.fn(async () => ({})),
  advanceFulfillment: vi.fn(async () => ({})),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { OrderDetailPage } from '../OrderDetailPage.js';

// A COMPLETE fixture, no cast: `as Order` hid two fields Order does not have
// (`orgId`, `updatedAt`) and one it requires (`createdBy`).
const order = (over: Partial<Order> = {}): Order => ({
  orderId: 'ord-1', status: 'paid', fulfillmentStatus: 'pending',
  items: [{ productId: 'p1', name: 'Widget', quantity: 2, unitPrice: 50 }],
  subtotal: 100, discount: 10, total: 90, currency: 'USD',
  createdAt: '2026-07-01T00:00:00.000Z', createdBy: 'user-1',
  ...over,
});
/** A row of the money summary: the <div> pairing a label with its amount. */
const summaryRow = (label: string): HTMLElement => screen.getByText(label).closest('div') as HTMLElement;
const drain = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
};

const view = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/commerce/orders/ord-1?org=org-1']}>
      <Routes><Route path="/commerce/orders/:orderId" element={<OrderDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(screen.getByText('Widget', { exact: false })).toBeTruthy());
};

beforeEach(() => {
  getOrder.mockReset(); listOrderRefunds.mockReset(); partialRefundOrder.mockReset(); confirmMock.mockReset();
  getOrder.mockResolvedValue(order({ taxTotal: 8, shippingCost: 5 }));
  listOrderRefunds.mockResolvedValue([]);
  partialRefundOrder.mockResolvedValue({});
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

describe('COM-G1: the bold bottom line is what was charged', () => {
  it('shows the CHARGED total, not the goods total, when tax/shipping apply', async () => {
    await view();
    // 90 goods + 8 tax + 5 shipping = 103 billed — on the row LABELLED Charged.
    expect(within(summaryRow('Charged')).getByText('$103.00')).toBeTruthy();
  });

  it('still shows the goods total, on its own labelled line — nothing is hidden', async () => {
    await view();
    expect(within(summaryRow('Order total')).getByText('$90.00')).toBeTruthy();
  });

  it('with no tax or shipping the summary stays ONE line', async () => {
    getOrder.mockResolvedValue(order());
    await view();
    // The two figures are equal, so a second row would be redundant noise.
    expect(screen.queryByText('Order total')).toBeNull();
    expect(screen.queryByText('Charged')).toBeNull();
    expect(within(summaryRow('Total')).getByText('$90.00')).toBeTruthy();
  });
});

describe('COM-G2: a partial refund is confirmed and bounded', () => {
  it('confirms before moving money, naming the amount', async () => {
    await view();
    fireEvent.click(screen.getByRole('button', { name: /partial refund/i }));
    fireEvent.change(screen.getByLabelText(/partial refund amount/i), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const opts = confirmMock.mock.calls[0]![0] as { title: string; danger?: boolean };
    expect(opts.danger).toBe(true);
    // CM-REFUND-FMT-1 — the page money formatter, never a raw "20 USD".
    expect(opts.title).toMatch(/\$20\.00/);
    expect(opts.title).not.toMatch(/20 USD/);
    // Accepting moves exactly this money on exactly this order, with an idempotency key.
    await waitFor(() => expect(partialRefundOrder).toHaveBeenCalledTimes(1));
    expect(partialRefundOrder).toHaveBeenCalledWith('org-1', 'ord-1', 20, expect.any(String));
  });

  it('declining the confirm does NOT refund', async () => {
    confirmMock.mockResolvedValue(false);
    await view();
    fireEvent.click(screen.getByRole('button', { name: /partial refund/i }));
    fireEvent.change(screen.getByLabelText(/partial refund amount/i), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await drain(); // let the post-confirm continuation run before asserting it did nothing
    expect(partialRefundOrder).not.toHaveBeenCalled();
  });

  it('shows how much is still refundable, against the CHARGE not the goods total', async () => {
    getOrder.mockResolvedValue(order({ taxTotal: 8, shippingCost: 5, refundedAmount: 3, status: 'partially_refunded' }));
    await view();
    fireEvent.click(screen.getByRole('button', { name: /partial refund/i }));
    // 103 charged − 3 already refunded = 100 remaining.
    expect(await screen.findByText(/\$100\.00 refundable/)).toBeTruthy();
    expect(screen.queryByText(/100 USD/)).toBeNull(); // CM-REFUND-FMT-1
  });

  it('CM-REFUND-FMT-1: a fractional ceiling keeps its minor units', async () => {
    // 103 charged − 3.50 refunded = 99.50. A round fixture cannot tell "$99.50" from
    // the pre-fix "99.5 USD" or from a formatter that drops cents.
    getOrder.mockResolvedValue(order({ taxTotal: 8, shippingCost: 5, refundedAmount: 3.5, status: 'partially_refunded' }));
    await view();
    fireEvent.click(screen.getByRole('button', { name: /partial refund/i }));
    expect(await screen.findByText('of $99.50 refundable')).toBeTruthy();
  });

  it('refuses an amount above the remaining, instead of sending it to be rejected', async () => {
    await view();
    fireEvent.click(screen.getByRole('button', { name: /partial refund/i }));
    const input = screen.getByLabelText(/partial refund amount/i);
    const apply = (): HTMLButtonElement => screen.getByRole('button', { name: /^apply$/i }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: '9999' } });
    expect(apply().disabled).toBe(true);
    // The boundary: exactly the remaining 103.00 is allowed, one cent over is not.
    fireEvent.change(input, { target: { value: '103' } });
    expect(apply().disabled).toBe(false);
    fireEvent.change(input, { target: { value: '103.01' } });
    expect(apply().disabled).toBe(true);
  });
});

describe('COM-G3: a failed refunds read is not silence', () => {
  it('says the refund history could not be loaded', async () => {
    getOrder.mockResolvedValue(order({ refundedAmount: 50, status: 'partially_refunded' }));
    listOrderRefunds.mockRejectedValue(new Error('refund ledger down'));
    await view();
    // Otherwise "Refunded −$50.00" sits above an absent list that reads as
    // "there are no refunds".
    expect(await screen.findByText(/refund history could not be loaded/i)).toBeTruthy();
  });

  it('a genuinely empty refund list says nothing', async () => {
    await view();
    await waitFor(() => expect(listOrderRefunds).toHaveBeenCalledWith('org-1', 'ord-1'));
    await drain();
    expect(screen.queryByText(/refund history could not be loaded/i)).toBeNull();
  });

  it('a successful read after a failure clears the warning', async () => {
    listOrderRefunds.mockRejectedValueOnce(new Error('transient'));
    await view();
    const warning = await screen.findByText(/refund history could not be loaded/i);
    listOrderRefunds.mockResolvedValue([]);
    fireEvent.click(within(warning.closest('[role="status"]') ?? warning).getByRole('button'));
    await waitFor(() => expect(screen.queryByText(/refund history could not be loaded/i)).toBeNull());
  });
});
