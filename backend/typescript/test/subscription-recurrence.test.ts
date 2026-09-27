/**
 * MERCH-E live recurrence (ADR 0279, PR 2 Part A):
 *   - runSubscriptionCycle is IDEMPOTENT per invoiceId (/architect finding 1): a
 *     re-delivered invoice.paid never places a second period order; a NEW invoice does;
 *   - the billing→commerce seam fires the registered hook (billing never imports commerce);
 *   - getProductSubscriptionByStripeId is tenant-scoped.
 * The matched-sub → live Stripe subscription path is exercised only with a real key
 * (demo-mode default), so this covers the deterministic host logic.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, __resetCommerce, type Product } from '../src/features/commerce/commerceService.js';
import { subscribeToProduct, runSubscriptionCycle, getProductSubscriptionByStripeId, __resetSubscriptions } from '../src/features/commerce/subscriptions.js';
import { setSubscriptionInvoiceHook, fireSubscriptionInvoicePaid } from '../src/features/billing/subscriptionInvoiceHook.js';

const T = 'default';
const ORG = 'org-sub-rec';
const subProduct = (): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Coffee', price: 100, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetSubscriptions(); });

describe('MERCH-E recurrence', () => {
  it('runSubscriptionCycle is idempotent per invoiceId (finding 1)', async () => {
    const p = await subProduct();
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: p.productId, interval: 'monthly' });
    const first = await runSubscriptionCycle(T, ORG, subscription.subscriptionId, 'inv_1');
    expect(first).not.toBeNull(); // period order placed
    const repeat = await runSubscriptionCycle(T, ORG, subscription.subscriptionId, 'inv_1');
    expect(repeat).toBeNull(); // SAME invoice re-delivered ⇒ no second order
    const nextPeriod = await runSubscriptionCycle(T, ORG, subscription.subscriptionId, 'inv_2');
    expect(nextPeriod).not.toBeNull(); // a NEW invoice ⇒ a new period order
  });

  it('the billing seam fires the registered hook (billing never imports commerce)', async () => {
    const seen: { stripeSubscriptionId: string; invoiceId: string }[] = [];
    setSubscriptionInvoiceHook(async (e) => { seen.push({ stripeSubscriptionId: e.stripeSubscriptionId, invoiceId: e.invoiceId }); });
    await fireSubscriptionInvoicePaid({ tenantId: T, stripeSubscriptionId: 'sub_123', invoiceId: 'inv_9' });
    expect(seen).toEqual([{ stripeSubscriptionId: 'sub_123', invoiceId: 'inv_9' }]);
    // an empty stripe subscription id (a plan-only invoice) is a no-op, not a fire.
    seen.length = 0;
    await fireSubscriptionInvoicePaid({ tenantId: T, stripeSubscriptionId: '', invoiceId: 'inv_x' });
    expect(seen).toHaveLength(0);
    setSubscriptionInvoiceHook(null);
  });

  it('getProductSubscriptionByStripeId is tenant-scoped', async () => {
    expect(await getProductSubscriptionByStripeId(T, 'sub_nope')).toBeNull();
    expect(await getProductSubscriptionByStripeId('other-tenant', 'sub_anything')).toBeNull();
  });

  it('ADR 0450 — a demo subscribe AND a renewal cycle both mark the order PAID + fire the paid-observer (entitlement re-grant)', async () => {
    const { registerOrderPaidObserver, getOrder } = await import('../src/features/commerce/commerceService.js');
    const paid: string[] = [];
    registerOrderPaidObserver(async (o) => { paid.push(o.orderId); });

    const product = await subProduct();
    const { subscription, firstOrder } = await subscribeToProduct({
      tenantId: T, orgId: ORG, createdBy: 'u', productId: product.productId, interval: 'monthly',
    });
    // Initial demo subscribe → the first period order is PAID + fulfilment fired
    // (previously it stayed `pending`, so the entitlement observer never ran).
    expect((await getOrder(T, ORG, firstOrder.orderId))?.status).toBe('paid');
    expect(paid).toContain(firstOrder.orderId);

    // Renewal cycle (the invoice.paid path) → the renewal order is PAID + the
    // observer fires again — the entitlement RE-GRANT on renewal (ADR 0450's blocker).
    const renewal = await runSubscriptionCycle(T, ORG, subscription.subscriptionId, 'inv_r1');
    expect(renewal).not.toBeNull();
    expect((await getOrder(T, ORG, renewal!.orderId))?.status).toBe('paid');
    expect(paid).toContain(renewal!.orderId);
  });
});
