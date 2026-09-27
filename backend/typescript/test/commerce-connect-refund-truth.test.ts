/**
 * MPL-3 / MPL-4 / MPL-5 / MPL-9 (WF-MKT-2) — the money-truth gaps on the refund
 * half of the charge/refund pair, and the one webhook anomaly with no operator
 * surface.
 *
 * MPL-3. `amount_refunded` had ZERO occurrences backend-wide. `charge.refunded`
 * fires for PARTIAL refunds too and `createStripeRefund` already supports
 * `amountMinor`, so a $1 goodwill refund on a $100 pack flipped the whole order
 * to `refunded`, `hasPaidOrder` then returned false, and the buyer lost the pack
 * — while the ledger recorded a full return. Two wrong facts from one missing read.
 *
 * MPL-4. `refundOrder` returned 200 with the order still `paid` (by design — the
 * flip rides the webhook) and NOTHING recorded that a refund had been issued. A
 * lost or mis-signed delivery left the order `paid` forever with no detector.
 *
 * MPL-5. The amount-MISMATCH branch means "money was captured and we did not
 * fulfil", and it was the one anomaly excluded from the operator exception feed —
 * on a rationale ("tenant-LESS by nature") that is true of the unknown-order
 * branch and false of this one, which reached its line only because the order
 * lookup succeeded.
 *
 * MPL-9. `sellerStats` admitted `refunded` and `disputed` into a counter named
 * `paid` at full gross and full fee.
 *
 * SYMMETRIC-PAIR NOTE. The purchase path already refused a missing/mismatched
 * amount rather than auto-passing. The refund path did the opposite: absent
 * amount ⇒ most destructive interpretation. Both halves now refuse, and both
 * surface. The cases below assert the refusal on BOTH halves so a future author
 * cannot fix one and leave the other.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import {
  __resetCommerceConnect, startOnboarding, syncSellerFromStripe, upsertPaidListing,
  setListingApproval, createCheckout, getOrder, handleConnectEvent, refundOrder,
  hasPaidOrder, sellerStats,
} from '../src/features/commerce-connect/connectService.js';
import { orders } from '../src/features/commerce-connect/stores.js';
import { listExceptions, __resetExceptionSources } from '../src/host/exceptionProjection.js';

/** Only this feature's sources are registered per case, so a peer feature's rows
 *  can never make an assertion here pass or fail for the wrong reason. */
const collectExceptions = async (tenantId: string) => (await listExceptions(tenantId)).rows;
import { registerCommerceConnectExceptionSources, REFUND_CONFIRMATION_SLA_MS } from '../src/features/commerce-connect/exceptionSources.js';

const SELLER = 'user:refund-seller';
const BUYER = 'user:refund-buyer';
const URLS = { successUrl: 'http://x/ok', cancelUrl: 'http://x/no' };

/** Demo seller + approved listing + a PAID order of 40.00 usd (4000 minor). */
async function paidOrder(pack: string): Promise<string> {
  await startOnboarding(SELLER, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
  await syncSellerFromStripe(SELLER);
  await upsertPaidListing(SELLER, { packName: pack, lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
  await setListingApproval(pack, 'approved');
  const { order } = await createCheckout(BUYER, pack, URLS);
  await handleConnectEvent({
    event: {
      id: `evt_${pack}`, type: 'payment_intent.succeeded',
      data: { object: { id: `pi_${pack}`, amount: 4000, currency: 'usd', metadata: { ccOrderId: order.orderId } } },
    },
  });
  return order.orderId;
}

const refundEvent = (orderId: string, amountRefunded: number | undefined): Parameters<typeof handleConnectEvent>[0] => ({
  event: {
    id: `evt_rf_${orderId}_${amountRefunded ?? 'none'}`, type: 'charge.refunded',
    data: { object: { id: 'ch_x', amount: 4000, ...(amountRefunded !== undefined ? { amount_refunded: amountRefunded } : {}), metadata: { ccOrderId: orderId } } },
  },
});

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => {
  await __resetCommerceConnect();
  __resetExceptionSources();
  registerCommerceConnectExceptionSources();
});

describe('MPL-3 — a PARTIAL refund is recorded as one, and does not revoke the pack', () => {
  it('$1 back on a $40 order → partially-refunded, the amount recorded, entitlement KEPT', async () => {
    const pack = 'vendor.partial.nodes';
    const orderId = await paidOrder(pack);
    expect(await hasPaidOrder(BUYER, pack)).toBe(true);

    const out = await handleConnectEvent(refundEvent(orderId, 100)); // 1.00 usd
    expect(out.handled).toBe(true);

    const o = (await getOrder(orderId))!;
    expect(o.status, 'a $1 refund must NOT read as a full refund').toBe('partially-refunded');
    expect(o.refundedMajorUnits, 'the ledger must record what was actually returned').toBe(1);
    expect(await hasPaidOrder(BUYER, pack), 'the buyer paid for the pack and still holds it').toBe(true);
  });

  it('the FULL amount → refunded, and the entitlement IS revoked (the other half of the pair)', async () => {
    const pack = 'vendor.full.nodes';
    const orderId = await paidOrder(pack);
    await handleConnectEvent(refundEvent(orderId, 4000));
    const o = (await getOrder(orderId))!;
    expect(o.status).toBe('refunded');
    expect(o.refundedMajorUnits).toBe(40);
    expect(await hasPaidOrder(BUYER, pack)).toBe(false);
  });

  it('an over-refund (Stripe can exceed on a re-refund race) clamps to the charge, never above', async () => {
    const orderId = await paidOrder('vendor.over.nodes');
    await handleConnectEvent(refundEvent(orderId, 999999));
    const o = (await getOrder(orderId))!;
    expect(o.status).toBe('refunded');
    expect(o.refundedMajorUnits).toBe(40);
  });

  it('amount_refunded is CUMULATIVE — a second partial overwrites, never accumulates', async () => {
    const pack = 'vendor.cumulative.nodes';
    const orderId = await paidOrder(pack);
    await handleConnectEvent(refundEvent(orderId, 500));  // 5.00 returned so far
    await handleConnectEvent(refundEvent(orderId, 1500)); // Stripe reports the RUNNING TOTAL
    const o = (await getOrder(orderId))!;
    // 15, not 20 — `+=` here would over-report the refund on every redelivery.
    expect(o.refundedMajorUnits).toBe(15);
    expect(o.status).toBe('partially-refunded');
  });
});

describe('MPL-3 — a refund event with NO amount is an anomaly, never an auto-full-refund', () => {
  it('leaves the status alone, stamps the anomaly, and KEEPS the entitlement', async () => {
    const pack = 'vendor.noamount.nodes';
    const orderId = await paidOrder(pack);
    const out = await handleConnectEvent(refundEvent(orderId, undefined));
    expect(out.handled, 'a malformed event must still be acked — a retry cannot fix it').toBe(true);

    const o = (await getOrder(orderId))!;
    expect(o.status, 'guessing "full" is what destroyed entitlements').toBe('paid');
    expect(o.anomaly?.kind).toBe('refund-amount-missing');
    expect(await hasPaidOrder(BUYER, pack)).toBe(true);
  });

  it('SYMMETRY — the purchase half refuses a mismatched amount the same way', async () => {
    // Both halves of charge/refund now refuse an unusable amount and surface it.
    const pack = 'vendor.symmetry.nodes';
    await startOnboarding(SELLER, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe(SELLER);
    await upsertPaidListing(SELLER, { packName: pack, lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval(pack, 'approved');
    const { order } = await createCheckout(BUYER, pack, URLS);
    await handleConnectEvent({
      event: { id: 'evt_bad', type: 'payment_intent.succeeded', data: { object: { id: 'pi_bad', amount: 1, currency: 'usd', metadata: { ccOrderId: order.orderId } } } },
    });
    const o = (await getOrder(order.orderId))!;
    expect(o.status).toBe('pending');
    expect(o.anomaly?.kind).toBe('purchase-amount-mismatch');
  });
});

describe('MPL-5 / WF-MKT-2 — the captured-but-unfulfilled order reaches the operator feed', () => {
  it('an amount-mismatch anomaly is projected as action-required for the SELLER tenant', async () => {
    const pack = 'vendor.exception.nodes';
    await startOnboarding(SELLER, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe(SELLER);
    await upsertPaidListing(SELLER, { packName: pack, lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval(pack, 'approved');
    const { order } = await createCheckout(BUYER, pack, URLS);
    await handleConnectEvent({
      event: { id: 'evt_mm', type: 'payment_intent.succeeded', data: { object: { id: 'pi_mm', amount: 100, currency: 'usd', metadata: { ccOrderId: order.orderId } } } },
    });

    const rows = await collectExceptions(SELLER);
    const row = rows.find((r) => r.id === `order-anomaly:${order.orderId}`);
    expect(row, `no exception row for the stranded order; got ${JSON.stringify(rows.map((r) => r.id))}`).toBeTruthy();
    expect(row!.severity).toBe('action-required');
    expect(row!.label).toMatch(/captured but NOT fulfilled/i);
  });

  it('the BUYER — who was actually charged — sees it too', async () => {
    const pack = 'vendor.exception2.nodes';
    await startOnboarding(SELLER, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe(SELLER);
    await upsertPaidListing(SELLER, { packName: pack, lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval(pack, 'approved');
    const { order } = await createCheckout(BUYER, pack, URLS);
    await handleConnectEvent({
      event: { id: 'evt_mm2', type: 'payment_intent.succeeded', data: { object: { id: 'pi_mm2', amount: 100, currency: 'usd', metadata: { ccOrderId: order.orderId } } } },
    });
    expect((await collectExceptions(BUYER)).some((r) => r.id === `order-anomaly:${order.orderId}`)).toBe(true);
  });

  it('a HEALTHY order produces NO exception row (the source is not simply always-on)', async () => {
    await paidOrder('vendor.healthy.nodes');
    expect((await collectExceptions(SELLER)).filter((r) => r.source === 'commerce-connect:order-anomalies')).toHaveLength(0);
  });

  it('the genuinely un-attributable branch stays excluded — an UNKNOWN order emits nothing', async () => {
    // The exclusion rationale the module states is correct for THIS branch and is
    // deliberately preserved: there is no order row to attribute to.
    const out = await handleConnectEvent({
      event: { id: 'evt_unknown', type: 'payment_intent.succeeded', data: { object: { id: 'pi_u', amount: 4000, currency: 'usd', metadata: { ccOrderId: 'cco_nonexistent' } } } },
    });
    expect(out.handled).toBe(false);
    expect(await collectExceptions(SELLER)).toHaveLength(0);
  });
});

describe('MPL-4 — an issued-but-unconfirmed refund is VISIBLE, and the response is honest', () => {
  it('the demo lane applies immediately and SAYS applied', async () => {
    const orderId = await paidOrder('vendor.demo-refund.nodes');
    const out = await refundOrder(orderId);
    expect(out.applied).toBe(true);
    expect(out.state).toBe('applied');
    expect(out.order.status).toBe('refunded');
  });

  it('a refund stamped long ago with the order still `paid` becomes an operator exception', async () => {
    const orderId = await paidOrder('vendor.stranded-refund.nodes');
    // The live lane is what strands; simulate its stamp directly rather than
    // standing up a Stripe double, because the DETECTOR is what is under test.
    const o = (await getOrder(orderId))!;
    await orders.put({ ...o, refundRequestedAt: new Date(Date.now() - REFUND_CONFIRMATION_SLA_MS - 60_000).toISOString(), refundId: 're_x' });

    const rows = await collectExceptions(SELLER);
    const row = rows.find((r) => r.id === `order-refund-unconfirmed:${orderId}`);
    expect(row, `the divergence must be visible; got ${JSON.stringify(rows.map((r) => r.id))}`).toBeTruthy();
    expect(row!.label).toMatch(/never confirmed/i);
  });

  it('a refund stamped MOMENTS ago does NOT alarm (the SLA is a real threshold, not decoration)', async () => {
    const orderId = await paidOrder('vendor.fresh-refund.nodes');
    const o = (await getOrder(orderId))!;
    await orders.put({ ...o, refundRequestedAt: new Date().toISOString(), refundId: 're_y' });
    expect((await collectExceptions(SELLER)).some((r) => r.id === `order-refund-unconfirmed:${orderId}`)).toBe(false);
  });

  it('once the webhook confirms, the alarm clears', async () => {
    const orderId = await paidOrder('vendor.confirmed-refund.nodes');
    const o = (await getOrder(orderId))!;
    await orders.put({ ...o, refundRequestedAt: new Date(Date.now() - REFUND_CONFIRMATION_SLA_MS - 60_000).toISOString(), refundId: 're_z' });
    await handleConnectEvent(refundEvent(orderId, 4000));
    expect((await collectExceptions(SELLER)).some((r) => r.id === `order-refund-unconfirmed:${orderId}`)).toBe(false);
  });
});

describe('MPL-9 / MKT-UX-4 — seller stats no longer count money that was taken back', () => {
  it('refunded and disputed are their own counts, and net is gross minus what came back', async () => {
    const kept = await paidOrder('vendor.stat-kept.nodes');
    void kept;
    // Second order, refunded in full.
    await upsertPaidListing(SELLER, { packName: 'vendor.stat-refunded.nodes', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('vendor.stat-refunded.nodes', 'approved');
    const r = await createCheckout('user:buyer-2', 'vendor.stat-refunded.nodes', URLS);
    await handleConnectEvent({
      event: { id: 'evt_s2', type: 'payment_intent.succeeded', data: { object: { id: 'pi_s2', amount: 4000, currency: 'usd', metadata: { ccOrderId: r.order.orderId } } } },
    });
    await handleConnectEvent(refundEvent(r.order.orderId, 4000));

    const { sales } = await sellerStats(SELLER);
    expect(sales.paid, 'a refunded sale must not be counted as paid').toBe(1);
    expect(sales.refunded).toBe(1);
    expect(sales.disputed).toBe(0);
    expect(sales.grossMajorUnitsByCurrency.usd).toBe(80);
    expect(sales.refundedMajorUnitsByCurrency.usd).toBe(40);
    expect(sales.netMajorUnitsByCurrency.usd, 'net is what the seller actually kept').toBe(40);
  });

  it('a PARTIALLY refunded sale counts as paid, with only the returned part in refunded', async () => {
    const orderId = await paidOrder('vendor.stat-partial.nodes');
    await handleConnectEvent(refundEvent(orderId, 1000)); // 10.00 back of 40.00
    const { sales } = await sellerStats(SELLER);
    expect(sales.paid).toBe(1);
    expect(sales.refunded).toBe(0);
    expect(sales.grossMajorUnitsByCurrency.usd).toBe(40);
    expect(sales.refundedMajorUnitsByCurrency.usd).toBe(10);
    expect(sales.netMajorUnitsByCurrency.usd).toBe(30);
  });

  it('a PENDING order is in `total` but in none of the money figures', async () => {
    // The MKT-UX-24(a) contradiction: "No sales yet" beside "All orders 1".
    await startOnboarding(SELLER, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe(SELLER);
    await upsertPaidListing(SELLER, { packName: 'vendor.stat-pending.nodes', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('vendor.stat-pending.nodes', 'approved');
    await createCheckout('user:buyer-3', 'vendor.stat-pending.nodes', URLS);
    const { sales } = await sellerStats(SELLER);
    expect(sales.total).toBe(1);
    expect(sales.paid).toBe(0);
    expect(sales.grossMajorUnitsByCurrency).toEqual({});
  });
});

/**
 * REVIEW FOLD-IN — the symmetric-pair rule applied to every remaining bare
 * `'paid'` literal on this surface, not just the two that were reported.
 *
 * Before this PR the literal was harmless everywhere: every non-`paid` status
 * meant no entitlement, so `status === 'paid'` and "is entitled" were the same
 * predicate. `partially-refunded` is the first status that is ENTITLED AND NOT
 * `paid`, which turned three separate literals into three live defects at once.
 * Each case below is written so it FAILS against the literal it replaces.
 */
describe('the ENTITLED set, not the `paid` literal — every site', () => {
  /** Paid $40 order, $1 returned ⇒ `partially-refunded` + entitlement kept. */
  async function partiallyRefunded(pack: string): Promise<string> {
    const orderId = await paidOrder(pack);
    await handleConnectEvent(refundEvent(orderId, 100));
    const o = (await getOrder(orderId))!;
    expect(o.status, 'fixture precondition').toBe('partially-refunded');
    return orderId;
  }

  const disputeEvent = (id: string, type: string, pi: string, status: string) => ({
    id, type,
    data: { object: { id: `dp_${id}`, payment_intent: pi, amount: 4000, currency: 'usd', reason: 'fraudulent', status } },
  });

  it('checkout: re-buying a PARTIALLY-REFUNDED order is refused, and the row is not overwritten', async () => {
    // `orders.ts` — the guard was `prior?.status === 'paid'`, so this re-POST
    // sailed through, the CAS rebuilt the row FRESH as `pending`, and Stripe's
    // `idempotencyKey: orderId` replayed the completed session (no new charge, no
    // webhook). Durable result: buyer loses the pack, the refund vanishes from the
    // ledger, the seller loses the sale from stats. Reachable by any editor+ in
    // the BUYER tenant — the SPA hides Buy on `purchased`, but the route is the
    // authority and an agent/tool caller reaches it directly.
    const pack = 'vendor.rebuy-partial.nodes';
    const orderId = await partiallyRefunded(pack);

    await expect(createCheckout(BUYER, pack, URLS)).rejects.toMatchObject({ httpStatus: 409 });

    const after = (await getOrder(orderId))!;
    expect(after.status, 'the refused re-buy must not move the row').toBe('partially-refunded');
    expect(after.refundedMajorUnits, 'the recorded refund must survive').toBe(1);
    expect(after.stripePaymentIntentId, 'the intent id must survive (a fresh claim drops it)').toBeTruthy();
    expect(await hasPaidOrder(BUYER, pack), 'the buyer must keep the pack they paid for').toBe(true);
  });

  it('dispute created: a PARTIALLY-REFUNDED order still flips to disputed', async () => {
    // `webhookHandlers.ts` — gated on `order.status === 'paid'`, so a dispute
    // against a partially-refunded order left it `partially-refunded`: stats
    // counted it under `paid` at FULL gross with only the partial in `refunded`,
    // so `net` overstated by the whole disputed amount, and the buyer kept the
    // entitlement through a lost dispute.
    const pack = 'vendor.dispute-partial.nodes';
    const orderId = await partiallyRefunded(pack);

    const out = await handleConnectEvent({ event: disputeEvent('evt_dp1', 'charge.dispute.created', `pi_${pack}`, 'needs_response') });
    expect(out.handled).toBe(true);
    expect((await getOrder(orderId))!.status).toBe('disputed');

    const { sales } = await sellerStats(SELLER);
    expect(sales.disputed, 'the dispute must be counted as one').toBe(1);
    expect(sales.paid, 'a disputed order is not a paid one').toBe(0);
    expect(sales.refundedMajorUnitsByCurrency.usd, 'a lost dispute takes the WHOLE charge back').toBe(40);
    expect(sales.netMajorUnitsByCurrency.usd, 'net must not overstate by the disputed amount').toBe(0);
  });

  it('dispute WON: the order returns to partially-refunded, never unconditionally to paid', async () => {
    // Found by the sweep rather than reported. With the guard above widened, a
    // `partially-refunded` order can now reach `disputed`; the restore arm was
    // `status: 'paid'`, which would strand a live `refundedMajorUnits` under a
    // status whose `sellerStats` branch adds NOTHING to `refunded` — re-creating
    // the same overstated `net` on the won path that the fix closes on the
    // created path.
    const pack = 'vendor.dispute-won-partial.nodes';
    const orderId = await partiallyRefunded(pack);
    await handleConnectEvent({ event: disputeEvent('evt_dp2', 'charge.dispute.created', `pi_${pack}`, 'needs_response') });
    await handleConnectEvent({ event: disputeEvent('evt_dp3', 'charge.dispute.closed', `pi_${pack}`, 'won') });

    const o = (await getOrder(orderId))!;
    expect(o.status, 'the row must return to the status it ACTUALLY held').toBe('partially-refunded');
    expect(o.refundedMajorUnits).toBe(1);

    const { sales } = await sellerStats(SELLER);
    expect(sales.paid, 'a won dispute is an entitled sale again').toBe(1);
    expect(sales.refundedMajorUnitsByCurrency.usd, 'the $1 partial must still be counted as returned').toBe(1);
    expect(sales.netMajorUnitsByCurrency.usd, 'net = 40 gross − 1 returned').toBe(39);
  });

  it('a dispute WON on an order with NO partial refund still restores plain `paid`', async () => {
    // The other side of the derivation — proves the new branch discriminates on
    // `refundedMajorUnits` rather than always returning `partially-refunded`.
    const pack = 'vendor.dispute-won-clean.nodes';
    const orderId = await paidOrder(pack);
    await handleConnectEvent({ event: disputeEvent('evt_dp4', 'charge.dispute.created', `pi_${pack}`, 'needs_response') });
    await handleConnectEvent({ event: disputeEvent('evt_dp5', 'charge.dispute.closed', `pi_${pack}`, 'won') });
    expect((await getOrder(orderId))!.status).toBe('paid');
  });

  it('refundOrder: a PARTIALLY-REFUNDED order is still refundable for the remainder', async () => {
    // `adminOps.ts` spelled the entitled set as two literals. Behaviour-preserving
    // today, but it is the same drift seam — pinned so the shared set stays shared.
    const orderId = await partiallyRefunded('vendor.refund-again.nodes');
    const out = await refundOrder(orderId);
    expect(out.order.status === 'refunded' || out.refundId !== undefined).toBe(true);
  });
});
