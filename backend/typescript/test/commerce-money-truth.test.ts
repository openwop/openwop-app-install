/**
 * Commerce ROUND 2 (UX_UPGRADE-commerce, pass 2) — the money-truth seams.
 *
 * Each test pins ONE finding from the R2 source pass. They are behavioural, not
 * attribute-level: every assertion is something an operator or a shopper would
 * see differently before and after.
 *
 *  - CM-P2-B1 a Stripe failure no longer WEDGES the order in `refunding`
 *  - CM-P2-B3 the order records WHICH lane refunded (state-only vs real money)
 *  - CM-P2-B4 `updateFulfillment` CASes, so it can't revert a concurrent refund
 *  - CM-P2-M7 an operator inventory edit appears in the "auditable ledger"
 *  - CM-P2-M1 a `free_shipping` coupon actually waives shipping
 *  - CM-P2-M2 a fixed coupon carries its currency and never crosses currencies
 *  - CM-P2-I3 money is quantized in the ORDER's currency (JPY has no minor unit)
 *  - CM-P2-I4 an unsupported currency is refused, not relabelled USD
 *  - CM-P2-M11 an AP2 mandate is verified against the CHARGE, and is required
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createProduct, getProduct, updateProduct, createOrder, markAsPaid, refundOrder, updateFulfillment,
  partialRefundOrder, createCoupon, listStockMovements, getOrder, quantizeMoney,
  orderChargeTotal, __resetCommerce,
} from '../src/features/commerce/commerceService.js';
import { OpenwopError } from '../src/types.js';
import { subscribeToProduct, cancelSubscription, getProductSubscription, __resetSubscriptions } from '../src/features/commerce/subscriptions.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { resolveAp2Payment } from '../src/features/commerce/ucp/ap2.js';
import * as stripeApi from '../src/features/billing/stripeApi.js';

const T = 'tenant-cm-r2';
const ORG = 'org-cm-r2';
const BY = 'user-cm-r2';

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
beforeEach(async () => { await __resetCommerce(); await __resetSubscriptions(); vi.restoreAllMocks(); });

async function subscribableProduct(): Promise<string> {
  const p = await createProduct({
    tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'Plan', price: 20, currency: 'USD',
    subscription: { enabled: true, intervals: ['monthly'], savePercent: 0 },
  });
  return p.productId;
}

async function paidOrder(opts: { price?: number; currency?: string; shipping?: boolean } = {}): Promise<{ orderId: string }> {
  const p = await createProduct({
    tenantId: T, orgId: ORG, createdBy: BY, type: 'physical', name: 'Widget',
    price: opts.price ?? 100, currency: opts.currency ?? 'USD', inventory: 10,
  });
  const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, lines: [{ productId: p.productId, quantity: 1 }] });
  await markAsPaid(T, ORG, o.orderId, 'pi_live_123', {});
  return { orderId: o.orderId };
}

describe('CM-P2-B1 — a failed Stripe refund must not wedge the order', () => {
  it('releases the claim when the failure PROVES no money moved (Stripe rejected it)', async () => {
    const { orderId } = await paidOrder();
    vi.spyOn(stripeApi, 'createStripeRefund').mockRejectedValue(
      new OpenwopError('validation_error', 'stripe rejected the request', 400, {}),
    );

    await expect(refundOrder(T, ORG, orderId, { stripeKey: 'sk_test_x', actor: BY })).rejects.toThrow(/rejected/i);

    const after = await getOrder(T, ORG, orderId);
    // The user-visible fact: the order is back in a state that HAS actions.
    expect(after?.status).toBe('paid');
    expect(after?.status).not.toBe('refunding');
  });

  it('a retry after the failure completes the refund', async () => {
    const { orderId } = await paidOrder();
    const spy = vi.spyOn(stripeApi, 'createStripeRefund')
      .mockRejectedValueOnce(new OpenwopError('validation_error', 'stripe rejected the request', 400, {}))
      .mockResolvedValueOnce({ id: 're_1', status: 'succeeded' });

    await expect(refundOrder(T, ORG, orderId, { stripeKey: 'sk_test_x', actor: BY })).rejects.toThrow();
    const done = await refundOrder(T, ORG, orderId, { stripeKey: 'sk_test_x', actor: BY });

    expect(done?.status).toBe('refunded');
    expect(done?.refundId).toBe('re_1');
    // The retry is safe because it replays the SAME refund, not a second one.
    expect(spy.mock.calls[1]?.[2]).toMatchObject({ idempotencyKey: `commerce-refund:${orderId}` });
  });

  it('an order ALREADY wedged in `refunding` can still be finished (the pre-R2 rows)', async () => {
    const { orderId } = await paidOrder();
    vi.spyOn(stripeApi, 'createStripeRefund').mockRejectedValue(new Error('boom'));
    // Sabotage the RELEASE itself (a crash between the Stripe failure and the release):
    // this is exactly the row the old code left behind on every failed refund.
    const realCas = storage.kvCompareAndSwap.bind(storage);
    const casSpy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { status?: string };
      if (key.includes(orderId) && row.status === 'paid') return { swapped: false, actual: expected };
      return realCas(key, expected, next);
    });

    await expect(refundOrder(T, ORG, orderId, { stripeKey: 'sk_x', actor: BY })).rejects.toThrow();
    expect((await getOrder(T, ORG, orderId))?.status).toBe('refunding'); // wedged, as before R2

    casSpy.mockRestore();
    vi.spyOn(stripeApi, 'createStripeRefund').mockResolvedValue({ id: 're_2', status: 'succeeded' });
    const done = await refundOrder(T, ORG, orderId, { stripeKey: 'sk_x', actor: BY });
    expect(done?.status).toBe('refunded');
    expect(done?.refundId).toBe('re_2');
  });
});

describe('CM-P2-B3 — which lane refunded is on the ORDER, not just the audit row', () => {
  it('a keyless (agent/workflow) refund is marked state-only', async () => {
    const { orderId } = await paidOrder();
    const o = await refundOrder(T, ORG, orderId, { actor: 'agent' });
    expect(o?.status).toBe('refunded');
    expect(o?.refundProvider).toBe('none'); // the screen can now say "no money returned"
  });

  it('a keyed refund is marked as real money', async () => {
    const { orderId } = await paidOrder();
    vi.spyOn(stripeApi, 'createStripeRefund').mockResolvedValue({ id: 're_9', status: 'succeeded' });
    const o = await refundOrder(T, ORG, orderId, { stripeKey: 'sk_x', actor: BY });
    expect(o?.refundProvider).toBe('stripe');
  });
});

describe('CM-P2-B4 — fulfillment must not clobber a concurrent refund', () => {
  it('a refund landing mid-write is not clobbered — the operator is told to reload', async () => {
    const { orderId } = await paidOrder({ price: 103 });

    // Land a partial refund INSIDE the fulfillment write's own read→write window (the
    // race the blind put lost silently). Deterministic, one shot.
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let fired = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { fulfillmentStatus?: string };
      if (!fired && key.includes(orderId) && row.fulfillmentStatus === 'shipped') {
        fired = true;
        await partialRefundOrder(T, ORG, orderId, 50, { refundKey: 'rk-1', actor: BY });
      }
      return realCas(key, expected, next);
    });

    await expect(updateFulfillment(T, ORG, orderId, 'shipped', { actor: BY }))
      .rejects.toThrow(/changed while you were updating/i);
    expect(fired).toBe(true);

    const after = await getOrder(T, ORG, orderId);
    expect(after?.refundedAmount).toBe(50);            // the refund survived
    expect(after?.status).toBe('partially_refunded');  // and so did its status
  });
});

describe('review fold-ins — the defects the independent pass found in the fix itself', () => {
  it('B-1: a concurrent reserve is NOT oversold by the metadata write', async () => {
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'physical', name: 'Bolt', price: 5, currency: 'USD', inventory: 12 });

    // A real reservation lands inside updateProduct's read→write window. The first cut
    // blind-put the stale count over it, then added the delta — selling 2 reserved units
    // twice, with a ledger that no longer summed to the stored count.
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let fired = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!fired && next.includes('Bolt renamed')) { // products ride the kernel adapter: match the payload, not the key shape
        fired = true;
        await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, lines: [{ productId: p.productId, quantity: 2 }] });
      }
      return realCas(key, expected, next);
    });

    await updateProduct(T, ORG, p.productId, { name: 'Bolt renamed', inventory: 40 }, { actor: BY });
    expect(fired).toBe(true);

    const after = await getProduct(T, ORG, p.productId);
    const moves = await listStockMovements(T, ORG, p.productId);
    const ledgerSum = moves.reduce((n, m) => n + m.delta, 0);
    expect(after?.inventory).toBe(38);        // 40 physical, 2 of them reserved
    expect(12 + ledgerSum).toBe(after?.inventory); // the ledger reconstructs the count
    expect(after?.name).toBe('Bolt renamed');      // …and the metadata patch still landed
  });

  it('B-3: a cross-currency coupon is REFUSED, not silently ignored', async () => {
    await createCoupon({ tenantId: T, orgId: ORG, code: 'USDONLY', type: 'fixed', value: 10, currency: 'USD', actor: BY });
    const eur = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'EUR thing', price: 90, currency: 'EUR' });
    // Returning 0 accepted the code, stamped it on the order and changed no price.
    await expect(createOrder({ tenantId: T, orgId: ORG, createdBy: BY, couponCode: 'USDONLY', lines: [{ productId: eur.productId, quantity: 1 }] }))
      .rejects.toThrow(/applies to USD orders only/i);
  });

  it('B-3: a fixed coupon with NO currency is refused rather than stamped USD', async () => {
    await expect(createCoupon({ tenantId: T, orgId: ORG, code: 'NOCCY', type: 'fixed', value: 25, actor: BY }))
      .rejects.toThrow(/must state the `currency`/i);
    // …while a percentage coupon still needs none.
    await expect(createCoupon({ tenantId: T, orgId: ORG, code: 'PCT', type: 'percentage', value: 5, actor: BY })).resolves.toBeTruthy();
  });

  it('M-1: a failed RESUME on a delivered order restores `fulfilled`, not `paid`', async () => {
    const { orderId } = await paidOrder();
    await updateFulfillment(T, ORG, orderId, 'delivered', { actor: BY });
    expect((await getOrder(T, ORG, orderId))?.status).toBe('fulfilled');

    // The bug is on the RESUME only: there `o.status` is itself 'refunding', so it can't
    // be the restore target and the first cut hard-coded 'paid'. (A probe against the
    // FIRST attempt is green either way — that path always restored correctly.)
    vi.spyOn(stripeApi, 'createStripeRefund').mockRejectedValue(new OpenwopError('internal_error', 'timed out', 502, {}));
    await expect(refundOrder(T, ORG, orderId, { stripeKey: 'sk_x', actor: BY })).rejects.toThrow();
    expect((await getOrder(T, ORG, orderId))?.status).toBe('refunding'); // ambiguous ⇒ claim held

    vi.spyOn(stripeApi, 'createStripeRefund').mockRejectedValue(new OpenwopError('validation_error', 'stripe rejected the request', 400, {}));
    await expect(refundOrder(T, ORG, orderId, { stripeKey: 'sk_x', actor: BY })).rejects.toThrow(/rejected/i);

    const after = await getOrder(T, ORG, orderId);
    expect(after?.status).toBe('fulfilled');       // NOT downgraded to paid
    expect(after?.fulfillmentStatus).toBe('delivered');
  });

  it('M-2: an AMBIGUOUS failure keeps the claim (we cannot say the money stayed put)', async () => {
    const { orderId } = await paidOrder();
    vi.spyOn(stripeApi, 'createStripeRefund').mockRejectedValue(
      new OpenwopError('internal_error', 'Stripe request failed: timed out.', 502, {}),
    );
    await expect(refundOrder(T, ORG, orderId, { stripeKey: 'sk_x', actor: BY })).rejects.toThrow(/timed out/i);
    // `refunding` is now a RECOVERABLE state with a retry action, so holding it is the
    // honest answer to "did the money leave?" — unlike claiming it is still paid.
    expect((await getOrder(T, ORG, orderId))?.status).toBe('refunding');
  });
});

describe('CM-P2-M7 — an operator inventory edit is a ledgered stock movement', () => {
  it('correcting the count writes a `manual-adjust` movement', async () => {
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'physical', name: 'Bolt', price: 5, currency: 'USD', inventory: 12 });
    const updated = await updateProduct(T, ORG, p.productId, { inventory: 40 }, { actor: BY });
    expect(updated?.inventory).toBe(40);

    const moves = await listStockMovements(T, ORG, p.productId);
    const manual = moves.filter((m) => m.reason === 'manual-adjust');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ delta: 28, inventoryAfter: 40, actor: BY });
  });
});

describe('CM-P2-M1 / M2 — coupons', () => {
  it('a free_shipping coupon actually waives the shipping the order is charged', async () => {
    // A flat shipping charge must actually EXIST, or "shipping is zero" proves nothing —
    // the first cut of this test passed against the unfixed code for exactly that reason.
    await setGovernancePolicy(T, { commerce: { flatShippingMinor: 800 } }, 'test'); // $8 flat
    await createCoupon({ tenantId: T, orgId: ORG, code: 'FREESHIP', type: 'free_shipping', value: 0, actor: BY });
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'physical', name: 'Boxed', price: 90, currency: 'USD', inventory: 5, weightGrams: 500 });
    const withShip = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, lines: [{ productId: p.productId, quantity: 1 }] });
    const free = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, couponCode: 'FREESHIP', lines: [{ productId: p.productId, quantity: 1 }] });

    expect(withShip.shippingCost).toBe(8); // the control: shipping IS charged without it
    expect(free.couponCode).toBe('FREESHIP');
    expect(free.shippingCost ?? 0).toBe(0);
    // …and the CHARGE is lower by exactly the shipping that was quoted without it.
    expect(orderChargeTotal(free)).toBe(orderChargeTotal(withShip) - (withShip.shippingCost ?? 0));
  });

  it('a fixed coupon captures its currency and does not cross currencies', async () => {
    const c = await createCoupon({ tenantId: T, orgId: ORG, code: 'TENOFF', type: 'fixed', value: 10, currency: 'EUR', actor: BY });
    expect(c.currency).toBe('EUR');

    const usd = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'USD thing', price: 90, currency: 'USD' });
    const eur = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'EUR thing', price: 90, currency: 'EUR' });

    // €10 must never come off a USD order — and the shopper is TOLD, rather than the
    // code being accepted with no price change (review B-3).
    await expect(createOrder({ tenantId: T, orgId: ORG, createdBy: BY, couponCode: 'TENOFF', lines: [{ productId: usd.productId, quantity: 1 }] }))
      .rejects.toThrow(/applies to EUR orders only/i);
    const onEur = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, couponCode: 'TENOFF', lines: [{ productId: eur.productId, quantity: 1 }] });
    expect(onEur.discount).toBe(10);
  });

  it('a percentage coupon is unaffected (it is currency-free by nature)', async () => {
    await createCoupon({ tenantId: T, orgId: ORG, code: 'TENPCT', type: 'percentage', value: 10, actor: BY });
    const usd = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'Thing', price: 90, currency: 'USD' });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, couponCode: 'TENPCT', lines: [{ productId: usd.productId, quantity: 1 }] });
    expect(o.discount).toBe(9);
  });
});

describe('CM-P2-I3 / I4 — currency handling', () => {
  it('quantizes in the currency: JPY has no minor unit, USD has two', () => {
    expect(quantizeMoney(1234.5, 'JPY')).toBe(1235);
    expect(quantizeMoney(1234.567, 'USD')).toBe(1234.57);
  });

  it('a JPY percentage discount never stores a fractional yen', async () => {
    await createCoupon({ tenantId: T, orgId: ORG, code: 'JPY10', type: 'percentage', value: 10, actor: BY });
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'Yen thing', price: 12345, currency: 'JPY' });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, couponCode: 'JPY10', lines: [{ productId: p.productId, quantity: 1 }] });
    expect(Number.isInteger(o.discount)).toBe(true);
    expect(Number.isInteger(o.total)).toBe(true);
  });

  it('an unsupported currency is REFUSED, not silently relabelled USD', async () => {
    await expect(createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'Swiss', price: 90, currency: 'CHF' }))
      .rejects.toThrow(/Unsupported currency/i);
  });
});

describe('CM-P2-M11 — an AP2 mandate authorizes the CHARGE', () => {
  const order = {
    orderId: 'ord-ap2', total: 90, taxTotal: 8, shippingCost: 5, currency: 'USD',
  } as Parameters<typeof resolveAp2Payment>[1];

  it('a goods-only mandate does not settle an order with tax and shipping', () => {
    expect(() => resolveAp2Payment({ ap2_mandate: { amount: 90, currency: 'USD' } }, order))
      .toThrow(/does not match the order charge/i);
  });

  it('a mandate for the full charge settles', () => {
    const r = resolveAp2Payment({ ap2_mandate: { id: 'm1', amount: 103, currency: 'USD' } }, order);
    expect(r.paymentIntentId).toBe('ap2:m1');
  });

  it('a mandate with NO amount is refused rather than skipping the check', () => {
    expect(() => resolveAp2Payment({ ap2_mandate: { id: 'm2', currency: 'USD' } }, order))
      .toThrow(/must state the `amount`/i);
  });
});

describe('CM-P2-B2 — a failed live subscribe must not mark the first order PAID', () => {
  it('leaves the first order pending when Stripe was configured but failed', async () => {
    const productId = await subscribableProduct();
    vi.spyOn(stripeApi, 'createStripeSubscription').mockRejectedValue(new Error('stripe 429'));

    const out = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly', stripeKey: 'sk_x' });

    // The whole paid fan-out (GMV, confirmation email, commission, entitlement grant)
    // hangs off this status. No money was collected, so it must not say paid.
    expect(out.firstOrder.status).toBe('pending');
    expect(out.subscription.degradedFromLive).toBe(true);
  });

  it('a GENUINE demo subscribe (no key configured) still grants immediately', async () => {
    const productId = await subscribableProduct();
    const out = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly' });
    expect(out.firstOrder.status).toBe('paid'); // ADR 0450 behaviour, preserved
    expect(out.subscription.degradedFromLive).toBeUndefined();
  });
});

describe('CM-P2-M8 — cancelling a subscription cancels it at the provider', () => {
  it('calls Stripe for a Stripe-linked subscription', async () => {
    const productId = await subscribableProduct();
    vi.spyOn(stripeApi, 'createStripeSubscription').mockResolvedValue({ subscriptionId: 'sub_live_1', customerId: 'cus_1' });
    const cancelSpy = vi.spyOn(stripeApi, 'cancelStripeSubscription').mockResolvedValue({ id: 'sub_live_1', status: 'canceled' });
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly', stripeKey: 'sk_x' });

    const out = await cancelSubscription(T, ORG, subscription.subscriptionId, { stripeKey: 'sk_x' });

    expect(cancelSpy).toHaveBeenCalledWith('sk_x', 'sub_live_1');
    expect(out?.status).toBe('canceled');
  });

  it('REFUSES a local-only cancel of a Stripe-linked subscription (charges would continue)', async () => {
    const productId = await subscribableProduct();
    vi.spyOn(stripeApi, 'createStripeSubscription').mockResolvedValue({ subscriptionId: 'sub_live_2', customerId: 'cus_2' });
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly', stripeKey: 'sk_x' });

    await expect(cancelSubscription(T, ORG, subscription.subscriptionId, { stripeKey: null }))
      .rejects.toThrow(/bills through Stripe/i);
    // …and the local record is untouched, so nothing claims it is cancelled.
    expect((await getProductSubscription(T, ORG, subscription.subscriptionId))?.status).toBe('active');
  });

  it('a demo subscription cancels locally with no provider call', async () => {
    const productId = await subscribableProduct();
    const cancelSpy = vi.spyOn(stripeApi, 'cancelStripeSubscription');
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly' });
    const out = await cancelSubscription(T, ORG, subscription.subscriptionId, {});
    expect(out?.status).toBe('canceled');
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe('review fold-ins (provider lanes)', () => {
  it('M-5: a subscription already cancelled at Stripe still completes locally', async () => {
    const productId = await subscribableProduct();
    vi.spyOn(stripeApi, 'createStripeSubscription').mockResolvedValue({ subscriptionId: 'sub_live_3', customerId: 'cus_3' });
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly', stripeKey: 'sk_x' });
    // The response to the first cancel was lost; the retry finds it already gone.
    vi.spyOn(stripeApi, 'cancelStripeSubscription').mockRejectedValue(new Error('No such subscription: sub_live_3'));

    const out = await cancelSubscription(T, ORG, subscription.subscriptionId, { stripeKey: 'sk_x' });
    expect(out?.status).toBe('canceled'); // …instead of wedging active-and-uncancellable
  });

  it('M-5: a genuine provider failure still refuses (no silent local-only cancel)', async () => {
    const productId = await subscribableProduct();
    vi.spyOn(stripeApi, 'createStripeSubscription').mockResolvedValue({ subscriptionId: 'sub_live_4', customerId: 'cus_4' });
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: BY, productId, interval: 'monthly', stripeKey: 'sk_x' });
    vi.spyOn(stripeApi, 'cancelStripeSubscription').mockRejectedValue(new Error('Stripe request failed: timed out.'));

    await expect(cancelSubscription(T, ORG, subscription.subscriptionId, { stripeKey: 'sk_x' })).rejects.toThrow(/timed out/i);
    expect((await getProductSubscription(T, ORG, subscription.subscriptionId))?.status).toBe('active');
  });

  it('I1: an AP2 mandate must state its currency, not just its amount', () => {
    const order = { orderId: 'o', total: 90, taxTotal: 8, shippingCost: 5, currency: 'EUR' } as Parameters<typeof resolveAp2Payment>[1];
    expect(() => resolveAp2Payment({ ap2_mandate: { id: 'm3', amount: 103 } }, order))
      .toThrow(/must state the `currency`/i);
  });
});
