/**
 * MERCH-E product subscriptions (ADR 0279):
 *  - subscribing places the FIRST period order at the save-and-save discounted price
 *    and records an active subscription (demo-mode without a Stripe key);
 *  - a non-subscribable product / unsupported interval is rejected;
 *  - runSubscriptionCycle places the next period order and advances nextOrderAt;
 *  - a canceled subscription runs no further cycles.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { createProduct, getOrder, __resetCommerce, type Product } from '../commerceService.js';
import { subscribeToProduct, runSubscriptionCycle, cancelSubscription, listProductSubscriptions, __resetSubscriptions, __putSubscriptionForTest } from '../subscriptions.js';
import { createOrder, listOrders } from '../commerceService.js';

const T = 'default';
const ORG = 'org-sub';
const subProduct = (save?: number): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Coffee', price: 100, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'], ...(save !== undefined ? { savePercent: save } : {}) } });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetSubscriptions(); });

describe('MERCH-E product subscriptions', () => {
  it('places the first order at the discounted price and records an active demo subscription', async () => {
    const p = await subProduct(10);
    const { subscription, firstOrder } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: p.productId, interval: 'monthly' });
    expect(subscription.status).toBe('active');
    expect(subscription.paymentMode).toBe('demo'); // no Stripe key
    expect(subscription.unitPrice).toBe(90); // 100 − 10%
    expect(firstOrder.total).toBe(90);
    expect(firstOrder.items[0]?.unitPrice).toBe(90);
    expect((await listProductSubscriptions(T, ORG))).toHaveLength(1);
  });

  it('rejects a non-subscribable product and an unsupported interval', async () => {
    const plain = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'One-off', price: 20, currency: 'USD' });
    await expect(subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: plain.productId, interval: 'monthly' })).rejects.toThrow();
    const p = await subProduct();
    await expect(subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: p.productId, interval: 'weekly' })).rejects.toThrow();
  });

  it('runs a recurring cycle placing the next period order, and stops when canceled', async () => {
    const p = await subProduct(0);
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: p.productId, interval: 'monthly' });
    const cycleOrder = await runSubscriptionCycle(T, ORG, subscription.subscriptionId);
    expect(cycleOrder).not.toBeNull();
    expect(cycleOrder!.total).toBe(100);
    // #2316 (ADR 0450 unblock): a renewal-cycle order FULFILS — it is marked paid
    // so the markAsPaid CAS observers (entitlements/seats/commission) fire.
    // test/subscription-recurrence.test.ts pins the full fulfilment behavior.
    expect((await getOrder(T, ORG, cycleOrder!.orderId))?.status).toBe('paid');
    await cancelSubscription(T, ORG, subscription.subscriptionId);
    expect(await runSubscriptionCycle(T, ORG, subscription.subscriptionId)).toBeNull();
  });

  it('ADR 0450 OQ3 — the FIRST live invoice adopts the pending first order instead of placing a second', async () => {
    const p = await subProduct(0);
    // Shape the LIVE-mode state no demo path can reach: a subscription whose first
    // order is still `pending` and that has never seen an invoice.
    const pending = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1, unitPriceOverride: 100 }] });
    expect(pending.status).toBe('pending');
    const now = new Date().toISOString();
    await __putSubscriptionForTest({
      subscriptionId: 'psub:live-1', tenantId: T, orgId: ORG, productId: p.productId, interval: 'monthly', unitPrice: 100, currency: 'USD',
      status: 'active', paymentMode: 'live', stripeSubscriptionId: 'sub_live', nextOrderAt: now, lastOrderId: pending.orderId,
      createdBy: 'u', createdAt: now, updatedAt: now,
    });
    const before = (await listOrders(T, ORG)).length;
    const adopted = await runSubscriptionCycle(T, ORG, 'psub:live-1', 'in_first');
    expect(adopted?.orderId).toBe(pending.orderId); // the SAME order, now paid — not a second one
    expect(adopted?.status).toBe('paid');
    expect((await listOrders(T, ORG)).length).toBe(before);
    // Idempotent per invoice (the existing last-invoice contract): re-delivering the
    // first invoice no-ops.
    expect(await runSubscriptionCycle(T, ORG, 'psub:live-1', 'in_first')).toBeNull();
    // The NEXT invoice is a real renewal: a new order is placed and paid.
    const renewal = await runSubscriptionCycle(T, ORG, 'psub:live-1', 'in_second');
    expect(renewal?.orderId).not.toBe(pending.orderId);
    expect(renewal?.status).toBe('paid');
    expect((await listOrders(T, ORG)).length).toBe(before + 1);
  });
});
