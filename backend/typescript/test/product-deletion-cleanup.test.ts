/**
 * grade-data (ADR 0279) — the deletion flow must fan out: deleting a product cancels
 * its active subscriptions so no `active` ProductSubscription outlives its product.
 * Exercises the real end-to-end flow (create subscribable product → subscribe →
 * deleteProduct) and asserts the sub is canceled AND runSubscriptionCycle no longer
 * mints an order for the deleted product — the orphan-with-teeth this pass closed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, deleteProduct, listOrders, __resetCommerce } from '../src/features/commerce/commerceService.js';
import {
  subscribeToProduct, runSubscriptionCycle, getProductSubscription,
  registerProductDeletionCleanup, __resetSubscriptions,
} from '../src/features/commerce/subscriptions.js';
import { __resetProductLifecycleHooks } from '../src/features/commerce/productLifecycleSeam.js';

const T = 'default';
const ORG = 'org-del';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => {
  await __resetCommerce();
  await __resetSubscriptions();
  __resetProductLifecycleHooks();
  registerProductDeletionCleanup(); // the boot-time registration (commerce feature.ts does this live)
});

describe('grade-data — product deletion cancels active subscriptions', () => {
  it('deleteProduct cancels the active sub and stops the recurrence clock', async () => {
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Coffee', price: 100, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'], savePercent: 10 } });
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: p.productId, interval: 'monthly' });
    expect(subscription.status).toBe('active');
    expect((await listOrders(T, ORG))).toHaveLength(1); // the first period order

    // Delete the product → the fan-out cancels the subscription.
    expect(await deleteProduct(T, ORG, p.productId)).toBe(true);
    const after = await getProductSubscription(T, ORG, subscription.subscriptionId);
    expect(after?.status).toBe('canceled');

    // The recurrence clock is closed: a cycle on the canceled sub mints no order.
    expect(await runSubscriptionCycle(T, ORG, subscription.subscriptionId)).toBeNull();
    expect((await listOrders(T, ORG))).toHaveLength(1); // still just the first order — no orphan billing
  });

  it('leaves subscriptions to OTHER products untouched', async () => {
    const keep = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Tea', price: 80, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });
    const drop = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Coffee', price: 100, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });
    const keepSub = (await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: keep.productId, interval: 'monthly' })).subscription;
    const dropSub = (await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: drop.productId, interval: 'monthly' })).subscription;

    await deleteProduct(T, ORG, drop.productId);

    expect((await getProductSubscription(T, ORG, dropSub.subscriptionId))?.status).toBe('canceled');
    expect((await getProductSubscription(T, ORG, keepSub.subscriptionId))?.status).toBe('active');
  });
});
