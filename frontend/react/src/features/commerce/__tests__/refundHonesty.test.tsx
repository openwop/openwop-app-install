/**
 * Commerce ROUND 2 (UX_UPGRADE-commerce, pass 2) — what the ORDER SCREEN says
 * about money that did or did not move.
 *
 *  - CM-P2-B3 a state-only refund (the agent/workflow lane, or a store with no
 *    Stripe key) is DISCLOSED; a real one is not mislabelled; and a pre-R2 row
 *    whose lane is unknown claims neither.
 *
 * The `refunding` retry UI is covered by `orderActionsWedged.test.tsx`, NOT here:
 * this file mocks `OrderActions` out, and an earlier version of this docblock
 * claimed the coverage anyway — the review deleted the whole retry block and all
 * 55 frontend tests still passed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getOrder, listOrderRefunds, CommerceApiError } = vi.hoisted(() => {
  class CommerceApiError extends Error {
    status: number;
    constructor(status: number) { super(`http ${status}`); this.status = status; }
  }
  return { getOrder: vi.fn(), listOrderRefunds: vi.fn(), CommerceApiError };
});
vi.mock('../commerceClient.js', () => ({ getOrder, listOrderRefunds, CommerceApiError }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ date: (d: string) => d, currency: (n: number) => String(n) }) }));
vi.mock('../commerceShared.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  StatusChip: ({ value }: { value: string }) => <span>{value}</span>,
  OrderActions: () => <div data-testid="order-actions" />,
}));
const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => access.value }));

import { OrderDetailPage } from '../OrderDetailPage.js';

const refunded = {
  orderId: 'ord_1', status: 'refunded', fulfillmentStatus: 'unfulfilled', createdAt: '2026-08-10',
  currency: 'USD', items: [{ productId: 'p1', name: 'Widget', quantity: 1, unitPrice: 100 }],
  subtotal: 100, discount: 0, total: 100, refundedAmount: 100,
};

function renderOrder(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/commerce/orders/ord_1?org=store_9']}>
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

describe('CM-P2-B3 — a refund that returned no money says so', () => {
  it('DISCLOSES a state-only refund', async () => {
    getOrder.mockResolvedValue({ ...refunded, refundProvider: 'none' });
    renderOrder();
    expect(await screen.findByText('refundStateOnly')).toBeTruthy();
  });

  it('does NOT label a real Stripe refund as state-only', async () => {
    getOrder.mockResolvedValue({ ...refunded, refundProvider: 'stripe', refundId: 're_1' });
    renderOrder();
    await waitFor(() => expect(getOrder).toHaveBeenCalled());
    expect(screen.queryByText('refundStateOnly')).toBeNull();
  });

  it('claims NOTHING for a pre-R2 row whose lane was never recorded', async () => {
    getOrder.mockResolvedValue(refunded); // no refundProvider at all
    renderOrder();
    await waitFor(() => expect(getOrder).toHaveBeenCalled());
    // Absence is unknown, not "no money returned" — asserting either way would lie.
    expect(screen.queryByText('refundStateOnly')).toBeNull();
  });

  it('marks a state-only entry in the partial-refund ledger too', async () => {
    getOrder.mockResolvedValue({ ...refunded, status: 'partially_refunded', refundedAmount: 40 });
    listOrderRefunds.mockResolvedValue([
      { refundLedgerId: 'rl_1', orderId: 'ord_1', refundKey: 'k1', amount: 40, currency: 'USD', provider: 'none', createdAt: '2026-08-10' },
    ]);
    renderOrder();
    expect(await screen.findByText('refundStateOnly')).toBeTruthy();
  });
});

describe('ADR 0615 — a claim that never completed must not read as a completed refund', () => {
  const row = {
    refundLedgerId: 'rl_9', orderId: 'ord_1', refundKey: 'k9', amount: 100,
    currency: 'USD', createdAt: '2026-08-31',
  };

  it('DISCLOSES a stranded refund the host could not record', async () => {
    // provider `stripe` + a real refundId: without the state chip this renders as a
    // clean, completed refund — the exact row an operator most needs to see.
    getOrder.mockResolvedValue({ ...refunded, refundedAmount: 0, status: 'paid' });
    listOrderRefunds.mockResolvedValue([
      { ...row, provider: 'stripe', refundId: 're_x', state: 'manual_intervention_required' },
    ]);
    renderOrder();
    expect(await screen.findByText('refundNeedsAttention')).toBeTruthy();
  });

  it('DISCLOSES an unconfirmed claim, and does NOT claim no money moved', async () => {
    // A crashed claim is stored `provider:'none'`, which the old chip would render as
    // "recorded only — no money returned". That is a lie: the provider may already
    // have taken it. It must say "unconfirmed" and must NOT say "state only".
    getOrder.mockResolvedValue({ ...refunded, refundedAmount: 0, status: 'paid' });
    listOrderRefunds.mockResolvedValue([{ ...row, provider: 'none', state: 'pending' }]);
    renderOrder();
    expect(await screen.findByText('refundUnconfirmed')).toBeTruthy();
    expect(screen.queryByText('refundStateOnly')).toBeNull();
  });

  it('leaves an APPLIED row reading exactly as it did before', async () => {
    getOrder.mockResolvedValue({ ...refunded, status: 'partially_refunded', refundedAmount: 100 });
    listOrderRefunds.mockResolvedValue([{ ...row, provider: 'none', state: 'applied' }]);
    renderOrder();
    expect(await screen.findByText('refundStateOnly')).toBeTruthy();
    expect(screen.queryByText('refundUnconfirmed')).toBeNull();
  });
});
