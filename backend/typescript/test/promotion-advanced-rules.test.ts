/**
 * MERCH-B advanced promotion rules (ADR 0274, PR 4 — closes MB-4):
 *   - tiered (buy-more-save-more): the reward fires once total quantity crosses minQuantity;
 *   - bogo: buy N ⇒ the cheapest M units of each (buy+get) group take the reward
 *     (percentage:100 = "get one free");
 *   - validation: tiered requires minQuantity, bogo requires bogo.buy/get.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPromotion, applyPromotionsUngated, __resetPromotions } from '../src/features/promotions/promotionsService.js';

const T = 'default';
const ORG = 'org-adv';
const cart = (unitPrice: number, quantity: number) => ({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: unitPrice * quantity, items: [{ productId: 'p1', unitPrice, quantity }] });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetPromotions(); });

describe('MERCH-B tiered', () => {
  it('fires only when total quantity crosses the tier threshold', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Buy 3+ save 10%', type: 'tiered', reward: { kind: 'percentage', value: 10 }, minQuantity: 3 });
    expect((await applyPromotionsUngated(cart(50, 2))).discount).toBe(0);   // 2 units — below tier
    expect((await applyPromotionsUngated(cart(50, 3))).discount).toBe(15);  // 3 units — 10% of 150
  });
  it('requires minQuantity', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'tiered', reward: { kind: 'percentage', value: 10 } })).rejects.toThrow();
  });
});

describe('MERCH-B bogo', () => {
  it('discounts the cheapest M units of each buy+get group (percentage 100 = free)', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 } });
    expect((await applyPromotionsUngated(cart(50, 2))).discount).toBe(50);   // 1 group of 2 → 1 free
    expect((await applyPromotionsUngated(cart(50, 4))).discount).toBe(100);  // 2 groups → 2 free
    expect((await applyPromotionsUngated(cart(50, 1))).discount).toBe(0);    // not enough for a group
  });
  it('requires bogo.buy/get', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'bogo', reward: { kind: 'percentage', value: 100 }, scope: { all: true } })).rejects.toThrow();
  });
});
