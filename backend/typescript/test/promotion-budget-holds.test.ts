/**
 * ADR 1025 D1 — a promotion's loss budget is RESERVED, not only derived (row 74, MCHWF-1).
 *
 * WHY: the budget used to be read from the order history, and the order that would count a
 * checkout's spend was written seconds later (after the inventory CAS and a network tax
 * quote). PROBED on `fc536023f`: five concurrent 1-unit checkouts against
 * `budget.maxDiscount: 10` burned 50. The order lane now appends a HOLD to the promotion's
 * ledger by compare-and-swap before the order exists; commerce commits it after the order
 * row lands and releases it on any failure; an orphaned hold expires.
 *
 * Through the REAL order path (`createOrder` + the wired seam), memory storage:
 *   1. concurrency vs `maxDiscount` — 5 concurrent checkouts burn exactly the cap;
 *   2. concurrency vs `maxQuantity` — 5 concurrent 1-unit checkouts discount exactly 2 units;
 *   3. a crashed checkout (hold taken, never committed) holds the budget until the TTL,
 *      then frees it by itself;
 *   4. a FAILED order (out of stock, after pricing) releases its hold at once;
 *   5. a preview never takes a hold;
 *   6. sequential orders count each spend once (hold + order are not double-counted
 *      into a refusal: cap 15, 10 then 5);
 *   7. deleting a promotion deletes its ledger.
 * Sabotage-witnessed 2026-11-02, each red with its guard removed: reserve off (legs 1, 2,
 * 6, 7), commit removed (6), release removed (4), expiry ignored (3), a preview reserving
 * (5), ledger delete removed (7); and after the closing review: 5 attempts with no
 * backoff (the 20-checkout leg), per-order instead of per-pair exclusion (the mixed leg).
 * Re-probed in /grade-tests wave 90: also a hold that carries no quantity (leg 2), the order
 * lane never reserving (the failed-order leg's took-a-hold control), and a fail-closed
 * evaluation on the second order (the mixed leg's leader-fired control).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, createOrder, __resetCommerce, type Order } from '../src/features/commerce/commerceService.js';
import {
  createPromotion, updatePromotion, deletePromotion, applyPromotions, applyPromotionsUngated, commitBudgetHolds, releaseBudgetHolds,
  BUDGET_HOLD_TTL_MS, __resetPromotions,
} from '../src/features/promotions/promotionsService.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { setOrderDiscountHook, setOrderPromotionHoldHooks } from '../src/features/commerce/promotionSeam.js';

const T = 'default';
const ORG = 'org-budget-holds';
const ledger = new DurableCollection<{ promotionId: string; tenantId: string; holds: { holdId: string; orderId?: string }[] }>('promotions:budget-hold', (l) => l.promotionId, undefined, (l) => l.tenantId);

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'promotions', label: 'Promotions', description: 'test', category: 'Business Tools', status: 'on', bucketUnit: 'tenant', salt: 'promotions' });
  setOrderDiscountHook(applyPromotions);
  setOrderPromotionHoldHooks({ commit: commitBudgetHolds, release: releaseBudgetHolds });
});
beforeEach(async () => { await __resetCommerce(); await __resetPromotions(); });
afterEach(() => { vi.useRealTimers(); });

const burned = (orders: Order[]): number => orders.reduce((s, o) => s + (o.appliedPromotions ?? []).reduce((a, x) => a + x.amount, 0), 0);
const units = (orders: Order[]): number => orders.reduce((s, o) => s + (o.appliedPromotions ?? []).reduce((a, x) => a + (x.quantity ?? 0), 0), 0);
const leader = async (budget: { maxDiscount?: number; maxQuantity?: number }, price = 20, inventory?: number) => {
  const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: inventory === undefined ? 'digital' : 'physical', name: 'Leader', price, currency: 'USD', categories: ['x'], ...(inventory !== undefined ? { inventory } : {}) });
  const promo = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'L', type: 'loss_leader', reward: { kind: 'fixed', value: 10 }, scope: { productIds: [p.productId] }, budget: { maxDiscount: 1000, ...budget }, currency: 'USD' });
  return { p, promo };
};
const order = (productId: string) => createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId, quantity: 1 }] });

describe('ADR 1025 D1 — budget holds', () => {
  it('5 concurrent checkouts burn exactly maxDiscount (was 5× the cap)', async () => {
    const { p } = await leader({ maxDiscount: 10 });
    const orders = await Promise.all(Array.from({ length: 5 }, () => order(p.productId)));
    expect(burned(orders)).toBe(10);
    // Exactly ONE checkout took the whole cap; the other four paid full price (a 5+5 split,
    // or a negative discount, cannot satisfy this).
    expect(orders.map((o) => burned([o])).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 10]);
  });

  it('5 concurrent 1-unit checkouts discount exactly maxQuantity units', async () => {
    const { p } = await leader({ maxQuantity: 2 });
    const orders = await Promise.all(Array.from({ length: 5 }, () => order(p.productId)));
    expect(units(orders)).toBe(2);
    expect(burned(orders)).toBe(20);
  });

  it('20 concurrent checkouts on a budget that is NOT exhausted all get the discount (grade MCHA-1)', async () => {
    // 5 attempts with no backoff failed late checkouts closed — full price — while budget
    // remained. Contention must cost time, not the shopper's discount.
    const { p } = await leader({ maxDiscount: 1000 });
    const orders = await Promise.all(Array.from({ length: 20 }, () => order(p.productId)));
    expect(orders.filter((o) => burned([o]) !== 10).length).toBe(0);
  });

  it('an order carrying a held AND an unheld promotion counts the unheld spend (per-pair exclusion, grade MCHA-2)', async () => {
    const { p, promo } = await leader({ maxDiscount: 1000 });
    // A stackable sitewide 10% with NO budget when the order is placed: no hold for it.
    // `currency` is set because the budget patched in below makes it denominated (ADR 1025 D4).
    const site = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Site', type: 'product_discount', reward: { kind: 'percentage', value: 10 }, scope: { all: true }, priority: -1, currency: 'USD' });
    const first = await order(p.productId);
    expect(first.appliedPromotions?.map((a) => a.promotionId)).toContain(site.promotionId);
    const siteSpend = first.appliedPromotions!.find((a) => a.promotionId === site.promotionId)!.amount;
    // The operator now caps the sitewide promotion at exactly what it already spent.
    await updatePromotion(T, ORG, site.promotionId, { budget: { maxDiscount: siteSpend } });
    // The leader's hold names `first`; excluding the whole order would forget its sitewide
    // spend and let it fire again.
    const second = await order(p.productId);
    // Positive control: the evaluation did not fail closed — the leader still fired — so the
    // sitewide promotion is absent because its spend was counted, not because nothing fired.
    expect(second.appliedPromotions?.map((a) => a.promotionId)).toEqual([promo.promotionId]);
  });

  it('a crashed checkout holds the budget until the TTL, then frees it by itself', async () => {
    const { p, promo } = await leader({ maxDiscount: 10 });
    // A checkout that priced (took the hold) and died before writing an order.
    const priced = await applyPromotionsUngated({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: 20, items: [{ productId: p.productId, unitPrice: 20, quantity: 1 }] }, { reserve: true });
    expect(priced.holdIds?.length).toBe(1);
    expect((await order(p.productId)).appliedPromotions ?? []).toEqual([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + BUDGET_HOLD_TTL_MS + 1_000);
    const after = await order(p.productId);
    expect(after.appliedPromotions?.[0]?.promotionId).toBe(promo.promotionId);
    expect(burned([after])).toBe(10);
  });

  it('a failed order (out of stock, after pricing) releases its hold at once', async () => {
    const { p: scarce, promo } = await leader({ maxDiscount: 10 }, 20, 0);
    await expect(order(scarce.productId)).rejects.toMatchObject({ details: { code: 'out_of_stock' } });
    const rows = await ledger.listForTenantIndexed(T);
    // A hold WAS taken (only a reserve writes a ledger row)…
    expect(rows.map((r) => r.promotionId)).toEqual([promo.promotionId]);
    // …and released at once, not left to expire at the TTL.
    expect(rows.flatMap((r) => r.holds)).toEqual([]);
  });

  it('a preview never takes a hold', async () => {
    const { p } = await leader({ maxDiscount: 10 });
    for (let i = 0; i < 3; i++) {
      const r = await applyPromotionsUngated({ tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: 20, items: [{ productId: p.productId, unitPrice: 20, quantity: 1 }] });
      expect(r.discount).toBe(10);
      expect(r.holdIds).toBeUndefined();
    }
    expect(burned([await order(p.productId)])).toBe(10);
  });

  it('sequential orders: each spend counts once (cap 15 → 10 then 5), and the hold names its order', async () => {
    const { p, promo } = await leader({ maxDiscount: 15 });
    const first = await order(p.productId);
    const second = await order(p.productId);
    expect([burned([first]), burned([second])]).toEqual([10, 5]);
    const row = await ledger.get(promo.promotionId);
    expect(row?.holds.map((h) => h.orderId).sort()).toEqual([first.orderId, second.orderId].sort());
  });

  it('deleting a promotion deletes its ledger', async () => {
    const { p, promo } = await leader({ maxDiscount: 10 });
    await order(p.productId);
    expect(await ledger.get(promo.promotionId)).not.toBeNull();
    await deletePromotion(T, ORG, promo.promotionId);
    expect(await ledger.get(promo.promotionId)).toBeNull();
  });
});
