/**
 * MERCH-B advanced promotion rules (ADR 0274, PR 4 — closes MB-4):
 *   - tiered (buy-more-save-more): the reward fires once total quantity crosses minQuantity;
 *   - bogo: buy N ⇒ the cheapest M units of each (buy+get) group take the reward
 *     (percentage:100 = "get one free");
 *   - validation: tiered requires minQuantity, bogo requires bogo.buy/get.
 *
 * Money fixtures are FRACTIONAL (0.29, 4.29, 19.99) so cent-dropping shows, and the
 * bogo carts mix prices so "cheapest" is distinguishable from "dearest" (a
 * single-price cart could not tell the sort direction apart — round 1 of
 * /grade-tests 8f w1 probed it vacuous). Expected amounts are summed by hand.
 *
 * Sabotages each case is red against (probed): the tier threshold `>=` → `>`,
 * the bogo sort reversed, the group count rounded up, either validation dropped.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPromotion, applyPromotionsUngated, __resetPromotions } from '../src/features/promotions/promotionsService.js';

const T = 'default';
const ORG = 'org-adv';
type Line = { productId: string; unitPrice: number; quantity: number };
const cartOf = (items: Line[], subtotalAfterCoupon: number) => ({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon, items });
const cart = (unitPrice: number, quantity: number, subtotal: number) => cartOf([{ productId: 'p1', unitPrice, quantity }], subtotal);

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetPromotions(); });

describe('MERCH-B tiered', () => {
  it('fires only when total quantity crosses the tier threshold', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Buy 3+ save 10%', type: 'tiered', reward: { kind: 'percentage', value: 10 }, minQuantity: 3 });
    expect((await applyPromotionsUngated(cart(0.29, 2, 0.58))).discount).toBe(0);   // 2 units — below tier
    expect((await applyPromotionsUngated(cart(0.29, 3, 0.87))).discount).toBe(0.09); // 3 units — 10% of 0.87 = 0.087 → 0.09
    expect((await applyPromotionsUngated(cart(19.99, 4, 79.96))).discount).toBe(8);  // 10% of 79.96 = 7.996 → 8.00
  });
  it('requires minQuantity', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'tiered', reward: { kind: 'percentage', value: 10 } }))
      .rejects.toMatchObject({ code: 'validation_error', message: 'A tiered promotion requires minQuantity (the buy-more-save-more threshold).', details: { field: 'minQuantity' } });
  });
});

describe('MERCH-B bogo', () => {
  it('discounts the cheapest M units of each buy+get group (percentage 100 = free)', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 } });
    const p1 = (q: number): Line => ({ productId: 'p1', unitPrice: 19.99, quantity: q });
    const p2: Line = { productId: 'p2', unitPrice: 4.29, quantity: 1 };
    const p3: Line = { productId: 'p3', unitPrice: 7.5, quantity: 1 };
    // 1 group of 2 → the CHEAPER unit (4.29) is free, never the 19.99 one
    expect((await applyPromotionsUngated(cartOf([p1(1), p2], 24.28))).discount).toBe(4.29);
    // 3 units → floor(3 / 2) = 1 group → only the cheapest (4.29)
    expect((await applyPromotionsUngated(cartOf([p1(1), p2, p3], 31.78))).discount).toBe(4.29);
    // 4 units → 2 groups → the two cheapest: 4.29 + 7.50 = 11.79
    expect((await applyPromotionsUngated(cartOf([p1(2), p2, p3], 51.77))).discount).toBe(11.79);
    expect((await applyPromotionsUngated(cart(19.99, 1, 19.99))).discount).toBe(0); // not enough for a group
  });
  it('requires bogo.buy/get', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true } }))
      .rejects.toMatchObject({ code: 'validation_error', message: 'A bogo promotion requires bogo.buy ≥ 1 and bogo.get ≥ 1.', details: { field: 'bogo' } });
  });
});
