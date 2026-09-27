/**
 * Promotions ROUND 2 (UX_UPGRADE-promotions, pass 2) — the money seams.
 *
 *  - PRO2-P1  a promotion's amounts are denominated; it never spends another currency
 *  - PRO2-P2  money is quantized in the ORDER's currency (JPY has no minor unit)
 *  - PRO2-P4  the loss budget is patchable (delete+recreate silently forgave the burn)
 *  - PRO2-P9  refunded / abandoned orders do not burn the budget forever
 *  - PRO2-P21 a NaN amount is refused (`NaN <= 0` is false, so it used to be pushed)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import {
  createProduct, createOrder, markAsPaid, refundOrder, __resetCommerce, type Product,
} from '../../commerce/commerceService.js';
import {
  createPromotion, updatePromotion, applyPromotions, applyPromotionsUngated, promotionUsage, __resetPromotions,
} from '../promotionsService.js';
import { registerToggleDefault } from '../../../host/featureToggles/registry.js';
import { setOrderDiscountHook } from '../../commerce/promotionSeam.js';

const T = 'default';
const ORG = 'org-promo-r2';

const mk = (name: string, price: number, currency = 'USD'): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price, currency, categories: ['all'] });

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // The order path only sees promotions through the WIRED seam — the cases below that go
  // via `createOrder` prove nothing without it (mechanism vs wiring, ADR 0502).
  registerToggleDefault({ id: 'promotions', label: 'Promotions', description: 'test', category: 'Business Tools', status: 'on', bucketUnit: 'tenant', salt: 'promotions' });
  setOrderDiscountHook(applyPromotions);
});
beforeEach(async () => { await __resetCommerce(); await __resetPromotions(); });

describe('PRO2-P1 — a promotion only spends its own currency', () => {
  it('a USD "spend 50, get 10 off" does not fire on a ¥3,000 order', async () => {
    await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Spend 50 get 10',
      type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50, currency: 'USD',
    });
    // ¥3,000 ≈ $20: it clears a bare `>= 50` instantly and would take ¥10 off — a
    // threshold met 60× too easily and a reward 150× too small.
    const r = await applyPromotionsUngated({
      tenantId: T, orgId: ORG, currency: 'JPY', subtotalAfterCoupon: 3000,
      items: [{ productId: 'p1', unitPrice: 3000, quantity: 1 }],
    });
    expect(r.discount).toBe(0);
  });

  it('…and does fire on a USD order of the same size', async () => {
    await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Spend 50 get 10',
      type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50, currency: 'USD',
    });
    const r = await applyPromotionsUngated({
      tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: 60,
      items: [{ productId: 'p1', unitPrice: 60, quantity: 1 }],
    });
    expect(r.discount).toBe(10);
  });

  it('a pure PERCENTAGE promotion stays currency-free (it is not an amount)', async () => {
    await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: '10% off everything',
      type: 'product_discount', reward: { kind: 'percentage', value: 10 }, scope: { all: true },
    });
    const r = await applyPromotionsUngated({
      tenantId: T, orgId: ORG, currency: 'JPY', subtotalAfterCoupon: 12345,
      items: [{ productId: 'p1', unitPrice: 12345, quantity: 1 }],
    });
    // PRO2-P2 — and the amount is quantized in JPY, which has no minor unit: the old
    // `Math.round(x*100)/100` stored ¥1234.5, an amount that cannot exist.
    expect(r.discount).toBe(1235);
    expect(Number.isInteger(r.discount)).toBe(true);
  });

  it('an unsupported currency is refused at intake, not relabelled', async () => {
    await expect(createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Bad', type: 'cart_threshold',
      reward: { kind: 'fixed', value: 10 }, minSpend: 50, currency: 'EURO',
    })).rejects.toThrow(/Unsupported currency/i);
  });
});

describe('PRO2-P4 — the loss budget can be changed', () => {
  it('patching the cap keeps the promotion (and therefore its burn history)', async () => {
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Leader', type: 'loss_leader',
      reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 500 },
    });
    // Before: `budget` was unreachable from every surface, so the only way to change a
    // cap was delete + recreate — which starts the derived burn at ZERO, orphaning every
    // dollar already given away onto the deleted id. Tightening a cap doubled exposure.
    const patched = await updatePromotion(T, ORG, promo.promotionId, { budget: { maxDiscount: 200 } });
    expect(patched?.budget?.maxDiscount).toBe(200);
    expect(patched?.promotionId).toBe(promo.promotionId); // same id ⇒ same burn history
  });

  it('a loss-leader cannot be stripped of its cap by a patch', async () => {
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Leader', type: 'loss_leader',
      reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 500 },
    });
    await expect(updatePromotion(T, ORG, promo.promotionId, { budget: {} })).rejects.toThrow(/needs a `budget.maxDiscount`/i);
  });
});

describe('PRO2-P9 — what actually burns the budget', () => {
  it('a REFUNDED order returns its share of the cap', async () => {
    const p = await mk('Leader', 100);
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Leader', type: 'loss_leader',
      reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 500 }, currency: 'USD',
    });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, o.orderId, 'demo:pi_1', {});
    expect((await promotionUsage(T, ORG)).get(promo.promotionId)?.amount).toBeGreaterThan(0);

    // The discount went back with the payment; the cap never got it back.
    await refundOrder(T, ORG, o.orderId, { actor: 'u' });
    expect((await promotionUsage(T, ORG)).get(promo.promotionId)?.amount ?? 0).toBe(0);
  });

  it('a paid order still burns it (the negative control)', async () => {
    const p = await mk('Leader', 100);
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Leader', type: 'loss_leader',
      reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 500 }, currency: 'USD',
    });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, o.orderId, 'demo:pi_2', {});
    expect((await promotionUsage(T, ORG)).get(promo.promotionId)?.amount).toBe(50);
  });
});

describe('review fold-ins — the four fixes the review proved were untested', () => {
  it('B1: usage does not throw on an order row with no currency', async () => {
    // `orderChargeTotal` resolves through `toStripeMinorUnits`, which throws on a row
    // with no `currency` — so computing it for EVERY order reddened the suite and, in
    // production, threw into `createOrder`'s catch: a silent full-price charge.
    const p = await mk('Leader', 100);
    await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Leader', type: 'loss_leader',
      reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 500 }, currency: 'USD',
    });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, o.orderId, 'demo:pi_b1', {});
    await expect(promotionUsage(T, ORG)).resolves.toBeInstanceOf(Map);
  });

  it('M1: a JPY cart_threshold snapshot is a whole yen (the two types the first fix missed)', async () => {
    await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'JPY 10%', type: 'cart_threshold',
      reward: { kind: 'percentage', value: 10 }, minSpend: 1000, currency: 'JPY',
    });
    const r = await applyPromotionsUngated({
      tenantId: T, orgId: ORG, currency: 'JPY', subtotalAfterCoupon: 3333,
      items: [{ productId: 'p1', unitPrice: 3333, quantity: 1 }],
    });
    // ¥333.3 cannot exist, and commerce re-quantizes the TOTAL to ¥333 — so the
    // snapshot that feeds the loss-budget ledger disagreed with the charge.
    expect(Number.isInteger(r.discount)).toBe(true);
    expect(r.appliedPromotions.every((a) => Number.isInteger(a.amount))).toBe(true);
  });

  it('M2: a pending cart holds its budget until its OWN reservation deadline', async () => {
    const p = await mk('Leader', 100);
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Leader', type: 'loss_leader',
      reward: { kind: 'percentage', value: 50 }, scope: { all: true }, budget: { maxDiscount: 500 }, currency: 'USD',
    });
    // Money in flight: it must keep holding the cap, or two concurrent checkouts both
    // see the full budget. (The earlier cut recomputed the deadline and released it
    // early, while the order was still payable.)
    await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] });
    expect((await promotionUsage(T, ORG)).get(promo.promotionId)?.amount).toBe(50);
  });

  it('M3: clearing a bogo promotion\'s scope deactivates it instead of leaving it Active-and-inert', async () => {
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'BOGO', type: 'bogo',
      reward: { kind: 'percentage', value: 100 }, scope: { all: true }, bogo: { buy: 1, get: 1 },
    });
    const patched = await updatePromotion(T, ORG, promo.promotionId, { scope: {} });
    expect(patched?.active).toBe(false); // `bogo` was missing from the guard's type list
  });

  it('M3: re-enabling a scope-pruned promotion does not bring it back Active-and-inert', async () => {
    const promo = await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Scoped', type: 'product_discount',
      reward: { kind: 'percentage', value: 10 }, scope: { all: true },
    });
    await updatePromotion(T, ORG, promo.promotionId, { scope: {} });      // pruned + deactivated
    const reEnabled = await updatePromotion(T, ORG, promo.promotionId, { active: true });
    // The old guard keyed on `patch.scope`, so this second door reopened it empty.
    expect(reEnabled?.active).toBe(false);
  });
});

describe('PRO2-P21 — a NaN amount is refused', () => {
  it('a non-numeric unit price does not produce a null-amount "applied" row', async () => {
    await createPromotion({
      tenantId: T, orgId: ORG, createdBy: 'u', name: '10% off', type: 'product_discount',
      reward: { kind: 'percentage', value: 10 }, scope: { all: true },
    });
    const r = await applyPromotionsUngated({
      tenantId: T, orgId: ORG, currency: 'USD', subtotalAfterCoupon: 100,
      items: [{ productId: 'p1', unitPrice: Number('not-a-price'), quantity: 1 }],
    });
    // `NaN <= 0` is FALSE, so the row used to be pushed and the tool reported
    // `{"amount": null}` with no error.
    expect(r.appliedPromotions.every((a) => Number.isFinite(a.amount))).toBe(true);
  });
});
