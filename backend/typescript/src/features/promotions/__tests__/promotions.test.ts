/**
 * Promotions (ADR 0274 / MERCH-B):
 *  - the engine computes a discount DELTA after resolvePrice+coupon (cart_threshold,
 *    product_discount, loss_leader) and it flows through createOrder into
 *    order.discount/total + a fired-promotion snapshot (ruling 7, replay-safe);
 *  - a loss_leader is capped by its budget, DERIVED from prior non-canceled order
 *    usage (leak-free) — a second order past the cap gets no discount;
 *  - a non-stackable promotion is exclusive;
 *  - a loss_leader MUST carry a budget (the loss cap).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { registerToggleDefault } from '../../../host/featureToggles/registry.js';
import { setOrderDiscountHook } from '../../commerce/promotionSeam.js';
import { createProduct, createOrder, __resetCommerce, type Product } from '../../commerce/commerceService.js';
import { createPromotion, applyPromotions, applyPromotionsUngated, __resetPromotions } from '../promotionsService.js';

const T = 'default';
const ORG = 'org-promo';
const mk = (name: string, price: number, cats: string[] = ['sale']): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price, currency: 'USD', categories: cats });

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'promotions', label: 'Promotions', description: 'test', category: 'Business Tools', status: 'on', bucketUnit: 'tenant', salt: 'promotions' });
  setOrderDiscountHook(applyPromotions); // wire the commerce order-discount hook
});
beforeEach(async () => { await __resetCommerce(); await __resetPromotions(); });

describe('MERCH-B promotions engine', () => {
  it('applies a cart_threshold promotion through createOrder and snapshots it', async () => {
    const p = await mk('Widget', 100);
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: '10% over $50', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 50 });
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(order.discount).toBe(10);
    expect(order.total).toBe(90);
    expect(order.appliedPromotions?.[0]?.type).toBe('cart_threshold');
    expect(order.appliedPromotions?.[0]?.amount).toBe(10);
  });

  it('does not fire a cart_threshold below its minSpend', async () => {
    const p = await mk('Cheap', 20);
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'over $50', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 50 });
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(order.discount).toBe(0);
    expect(order.appliedPromotions).toBeUndefined();
  });

  it('caps a loss_leader at its budget, derived from prior order usage (leak-free)', async () => {
    const p = await mk('Leader', 100);
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Loss leader', type: 'loss_leader', reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 30 } });
    const o1 = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(o1.discount).toBe(30); // 50% of 100 = 50, capped to the 30 loss budget
    const o2 = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(o2.discount).toBe(0); // budget exhausted by o1
    expect(o2.appliedPromotions).toBeUndefined();
  });

  it('a non-stackable promotion is exclusive of lower-priority ones', async () => {
    const p = await mk('Widget', 100);
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'excl', type: 'product_discount', reward: { kind: 'percentage', value: 20 }, scope: { all: true }, priority: 10, stackable: false });
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'stack', type: 'cart_threshold', reward: { kind: 'fixed', value: 5 }, minSpend: 1, priority: 1 });
    const r = await applyPromotionsUngated({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: 100, items: [{ productId: p.productId, unitPrice: 100, quantity: 1 }] });
    expect(r.discount).toBe(20); // only the exclusive 20% fires; the +$5 is blocked
    expect(r.appliedPromotions).toHaveLength(1);
  });

  it('requires a budget on a loss_leader', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'loss_leader', reward: { kind: 'percentage', value: 50 }, scope: { all: true } })).rejects.toThrow();
  });

  it('rejects an unknown type and an over-100 percentage', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'x', type: 'nope', reward: { kind: 'percentage', value: 10 } })).rejects.toThrow();
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'x', type: 'cart_threshold', reward: { kind: 'percentage', value: 150 } })).rejects.toThrow();
  });
});
