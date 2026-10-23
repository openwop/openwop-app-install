/**
 * PROMO-MAXQTY — `budget.maxQuantity` is a discounted-UNIT cap, enforced the same
 * DERIVED, leak-free way as `budget.maxDiscount` (ADR 0211/0274 doctrine): the
 * cumulative units a promotion has granted come from `appliedPromotions.quantity`
 * across non-canceled orders, no separate counter. Applies to the per-unit reward
 * types (bogo / product_discount / loss_leader); N/A to the cart-level types.
 * (Previously modelled + persisted but never enforced — a money-safety gap.)
 *
 * Sabotages each case is red against (probed, /grade-tests 8f w1): the within-order
 * `slice(0, remaining)` cap removed, canceled orders counted, and the exhausted
 * early return removed. That last one is reached only by an OVER-spent budget
 * (prior units > cap: `slice(0, negative)` keeps units); at exactly-spent the
 * empty slice also yields 0 (a double guard there), so the exhausted case ends on
 * an over-spent budget.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPromotion, applyPromotionsUngated, __resetPromotions } from '../src/features/promotions/promotionsService.js';
import type { Order } from '../src/features/commerce/commerceService.js';

const T = 'default';
const ORG = 'org-maxqty';
const cart = (unitPrice: number, quantity: number) => ({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: unitPrice * quantity, items: [{ productId: 'p1', unitPrice, quantity }] });

// The fields quantityUsed()/listOrders() actually read — persisted on the real
// `commerce:order` key so the derived budget reads them back. Picked FROM the
// product's `Order`, so a renamed field or status value reds tsc.
// (`createdAt` is what `listOrders` sorts by — a seed without it throws once two
// orders exist in the org.)
type SeedOrder = Pick<Order, 'orderId' | 'tenantId' | 'orgId' | 'status' | 'createdAt' | 'appliedPromotions'>;
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
    const r = await applyPromotionsUngated(cart(19.99, 5)); // 5 × 9.995 uncapped → 2 × 9.995 = 19.99 capped
    expect(r.discount).toBe(19.99);
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
    await seedOrders.put({ orderId: 'o1', tenantId: T, orgId: ORG, createdAt: '2026-10-01T10:00:00.000Z', status: 'paid', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 100, quantity: 2 }] });
    const r = await applyPromotionsUngated(cart(50, 4)); // would free 2; only 3-2=1 remains
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(1);
    expect(r.discount).toBe(50);
  });

  it('a CANCELED prior order does not consume the budget', async () => {
    const p = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO budget 1', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 }, budget: { maxQuantity: 1 } });
    await seedOrders.put({ orderId: 'o2', tenantId: T, orgId: ORG, createdAt: '2026-10-01T11:00:00.000Z', status: 'canceled', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 50, quantity: 1 }] });
    const r = await applyPromotionsUngated(cart(50, 2)); // canceled prior doesn't count → 1 free still available
    expect(r.appliedPromotions).toHaveLength(1); expect(r.appliedPromotions[0]?.quantity).toBe(1);
    expect(r.discount).toBe(50);
  });

  it('an exhausted budget skips the promotion entirely', async () => {
    const p = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO budget 2', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 }, budget: { maxQuantity: 2 } });
    await seedOrders.put({ orderId: 'o3', tenantId: T, orgId: ORG, createdAt: '2026-10-01T12:00:00.000Z', status: 'paid', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 100, quantity: 2 }] });
    const r = await applyPromotionsUngated(cart(50, 4)); // budget spent (2 of 2) → no discount
    expect(r.discount).toBe(0);
    expect(r.appliedPromotions).toHaveLength(0);
    // OVER-spent (3 of 2, e.g. the cap was lowered after these orders): still skipped
    await seedOrders.put({ orderId: 'o4', tenantId: T, orgId: ORG, createdAt: '2026-10-01T13:00:00.000Z', status: 'paid', appliedPromotions: [{ promotionId: p.promotionId, type: 'bogo', amount: 50, quantity: 1 }] });
    const over = await applyPromotionsUngated(cart(50, 4));
    expect(over.discount).toBe(0);
    expect(over.appliedPromotions).toHaveLength(0);
  });
});
