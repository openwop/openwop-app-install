/**
 * CM-P2-B1 (review M-7) — the `refunding` action cluster.
 *
 * The order-detail tests mock `OrderActions` out entirely, so the one piece of
 * UI B1 shipped had NO coverage: the review deleted the retry block outright and
 * every frontend test still passed. This renders the real component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const client = vi.hoisted(() => ({
  payOrder: vi.fn(), refundOrder: vi.fn(), partialRefundOrder: vi.fn(),
  cancelOrder: vi.fn(), advanceFulfillment: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../commerceClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...client }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));

import { OrderActions } from '../commerceShared.js';
import type { Order } from '../commerceClient.js';

// A COMPLETE fixture, not an `as Order` cast: the cast let the object drift from the
// type (`fulfillmentStatus: 'unfulfilled'` is not even a member) and the unit-test
// type ratchet — the only gate that reads test types — caught it after the merge.
const order = (status: Order['status']): Order => ({
  orderId: 'ord_1', status, fulfillmentStatus: 'pending', createdAt: '2026-08-10',
  currency: 'USD', items: [{ productId: 'p1', name: 'Widget', quantity: 1, unitPrice: 100 }],
  subtotal: 100, discount: 0, total: 100, createdBy: 'user-1',
});

beforeEach(() => {
  cleanup();
  for (const f of Object.values(client)) f.mockReset();
  client.refundOrder.mockResolvedValue({});
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

describe('an order wedged mid-refund is recoverable from the UI', () => {
  it('offers a retry and says the refund was interrupted', async () => {
    const onChanged = vi.fn();
    render(<OrderActions orgId="store_9" order={order('refunding')} onChanged={onChanged} />);
    expect(screen.getByText('refundInterrupted')).toBeTruthy();
    // "Recoverable" means the retry RESUMES THE REFUND for this order — presence alone
    // could not fail if the button were rewired (the header's own incident).
    fireEvent.click(screen.getByRole('button', { name: 'refundRetry' }));
    await waitFor(() => expect(client.refundOrder).toHaveBeenCalledWith('store_9', 'ord_1'));
    expect(client.refundOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect((confirmMock.mock.calls[0]![0] as { danger?: boolean }).danger).toBe(true);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('does NOT show the interrupted state on a healthy paid order (the negative control)', () => {
    render(<OrderActions orgId="store_9" order={order('paid')} onChanged={() => undefined} />);
    expect(screen.queryByText('refundInterrupted')).toBeNull();
    expect(screen.queryByRole('button', { name: 'refundRetry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'refund' })).toBeTruthy(); // the normal action still renders
  });
});
