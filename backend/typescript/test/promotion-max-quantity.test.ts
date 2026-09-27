/**
 * PROMO-MAXQTY — `budget.maxQuantity` is a discounted-UNIT cap, enforced the same
 * DERIVED, leak-free way as `budget.maxDiscount` (ADR 0211/0274 doctrine): the
 * cumulative units a promotion has granted come from `appliedPromotions.quantity`
 * across non-canceled orders, no separate counter. Applies to the per-unit reward
 * types (bogo / product_discount / loss_leader); N/A to the cart-level types.
 * (Previously modelled + persisted but never enforced — a money-safety gap.)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPromotion, applyPromotionsUngated, __resetPromotions } from '../src/features/promotions/promotionsService.js';

const T = 'default';
const ORG = 'org-maxqty';
const cart = (unitPrice: number, quantity: number) => ({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: unitPrice * quantity, items: [{ productId: 'p1', unitPrice, quantity }] });

// The fields quantityUsed()/listOrders() actually read — persisted on the real
// `commerce:order` key so the derived budget reads them back.
interface SeedOrder { orderId: string; tenantId: string; orgId: string; status: string; appliedPromotions: { promotionId: string; type: string; amount: number; quantity?: number }[] }
const seedOrders = new DurableCollection<SeedOrder>('commerce:order', (o) => o.orderId, undefined, (o) => o.tenantId);

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetPromotions(); await seedOrders.__clear(); });

describe('PROMO-MAXQTY — within-order cap + recorded quantity', () => {
  it('bogo: caps the free units to maxQuantity (keeps the cheapest)', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO capped', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 }, budget: { maxQuantity: 1 } });
    const r = await applyPromotionsUngated(cart(50, 4)); // 2 free uncapped → capped to 1
    expect(r.discount).toBe(50);
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(1);
  });

  it('product_discount: caps the discounted-unit count to maxQuantity', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Half off, max 2', type: 'product_discount', reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxQuantity: 2 } });
    const r = await applyPromotionsUngated(cart(50, 5)); // 5×25=125 uncapped → 2×25=50 capped
    expect(r.discount).toBe(50);
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(2);
  });

  it('no maxQuantity ⇒ unchanged discount, and the granted unit count is recorded', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Half off', type: 'product_discount', reward: { kind: 'percentage', value: 50 }, scope: { all: true } });
    const r = await applyPromotionsUngated(cart(50, 4)); // 4×25 = 100 (byte-identical to the pre-enforcement path)
    expect(r.discount).toBe(100);
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(4);
  });
});

describe('PROMO-MAXQTY — cumulative across orders (derived, leak-free)', () => {
  it('prior discounted units count against the remaining budget', async () => {
    const p = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO budget 3', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 }, budget: { maxQuantity: 3 } });
    await seedOrders.put({ orderId: 'o1', tenantId: T, orgId: ORG, status: 'paid', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 100, quantity: 2 }] });
    const r = await applyPromotionsUngated(cart(50, 4)); // would free 2; only 3-2=1 remains
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(1);
    expect(r.discount).toBe(50);
  });

  it('a CANCELED prior order does not consume the budget', async () => {
    const p = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO budget 1', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 }, budget: { maxQuantity: 1 } });
    await seedOrders.put({ orderId: 'o2', tenantId: T, orgId: ORG, status: 'canceled', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 50, quantity: 1 }] });
    const r = await applyPromotionsUngated(cart(50, 2)); // canceled prior doesn't count → 1 free still available
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(1);
    expect(r.discount).toBe(50);
  });

  it('an exhausted budget skips the promotion entirely', async () => {
    const p = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO budget 2', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 }, budget: { maxQuantity: 2 } });
    await seedOrders.put({ orderId: 'o3', tenantId: T, orgId: ORG, status: 'paid', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 100, quantity: 2 }] });
    const r = await applyPromotionsUngated(cart(50, 4)); // budget spent → no discount
    expect(r.discount).toBe(0);
    expect(r.appliedPromotions).toHaveLength(0);
  });
});
