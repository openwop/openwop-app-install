/**
 * Promotions (ADR 0274 / MERCH-B):
 *  - the engine computes a discount DELTA after resolvePrice+coupon (cart_threshold,
 *    product_discount, loss_leader) and it flows through createOrder into
 *    order.discount/total + a fired-promotion snapshot (ruling 7, replay-safe);
 *  - a loss_leader is capped by its budget, DERIVED from prior order usage (leak-free)
 *    — a second order past the cap gets no discount (which order states are excluded
 *    from the burn — refunded, expired-pending — is promotionsHonesty's claim; no case
 *    here cancels an order);
 *  - a non-stackable promotion is exclusive;
 *  - a loss_leader MUST carry a budget (the loss cap).
 *
 * Money fixtures are one-cent sensitive (59.99 × 10% = 5.999 → 6.00; 49.99 is one cent
 * under a 50 threshold; a 29.99 cap). Sabotage witnesses (w74, re-witnessed w102 after #5469; promotionsService.ts):
 * a ÷1000 percentage reds case 1; ignoring minSpend reds 2; dropping the budget cap, or
 * reading prior usage as 0, reds 3; ignoring `stackable: false` reds 4; dropping the
 * loss-leader budget refusal reds 5; accepting an unknown type or a >100% reward reds 6.
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
    const p = await mk('Widget', 59.99);
    const promo = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: '10% over $50', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, currency: 'USD', minSpend: 50 });
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(order.discount).toBe(6); // 59.99 × 10% = 5.999 → 6.00
    expect(Math.round(order.total * 100)).toBe(5399); // 59.99 − 6.00, in minor units
    expect(order.appliedPromotions).toEqual([{ promotionId: promo.promotionId, type: 'cart_threshold', name: '10% over $50', amount: 6 }]);
  });

  it('does not fire a cart_threshold below its minSpend', async () => {
    const p = await mk('Cheap', 49.99); // one cent under the threshold
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'over $50', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, currency: 'USD', minSpend: 50 });
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(order.discount).toBe(0);
    expect(order.appliedPromotions).toBeUndefined();
  });

  it('caps a loss_leader at its budget, derived from prior order usage (leak-free)', async () => {
    const p = await mk('Leader', 100);
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Loss leader', type: 'loss_leader', reward: { kind: 'percentage', value: 50 }, currency: 'USD', scope: { all: true }, budget: { maxDiscount: 29.99 } });
    const o1 = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(o1.discount).toBe(29.99); // 50% of 100 = 50, capped to the 29.99 loss budget
    const o2 = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(o2.discount).toBe(0); // budget exhausted by o1
    expect(o2.appliedPromotions).toBeUndefined();
  });

  it('a non-stackable promotion is exclusive of lower-priority ones', async () => {
    const p = await mk('Widget', 100);
    const excl = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'excl', type: 'product_discount', reward: { kind: 'percentage', value: 20 }, scope: { all: true }, priority: 10, stackable: false });
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'stack', type: 'cart_threshold', reward: { kind: 'fixed', value: 5 }, currency: 'USD', minSpend: 1, priority: 1 });
    const r = await applyPromotionsUngated({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: 100, items: [{ productId: p.productId, unitPrice: 100, quantity: 1 }] });
    expect(r.discount).toBe(20); // only the exclusive 20% fires; the +$5 is blocked
    expect(r.appliedPromotions.map((a) => a.promotionId)).toEqual([excl.promotionId]);
  });

  it('requires a budget on a loss_leader', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'loss_leader', reward: { kind: 'percentage', value: 50 }, scope: { all: true } })).rejects.toThrow(/requires budget\.maxDiscount/);
  });

  it('rejects an unknown type and an over-100 percentage', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'x', type: 'nope', reward: { kind: 'percentage', value: 10 } })).rejects.toThrow(/type must be one of/);
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'x', type: 'cart_threshold', reward: { kind: 'percentage', value: 150 } })).rejects.toThrow(/A percentage reward cannot exceed 100/);
  });
});
