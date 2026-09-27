/**
 * MERCH-E full recurrence bridge (ADR 0279, grade-code remediation) — the gap the unit
 * tests couldn't reach: the END-TO-END money-moving path with a REAL (mocked) Stripe.
 * A mock Stripe endpoint (OPENWOP_STRIPE_API_BASE override) lets subscribeToProduct create
 * a live subscription (exercising createStripeSubscription), then a Stripe invoice.paid
 * webhook drives the next period order via the billing→commerce seam — and a re-delivered
 * invoice is idempotent.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, listOrders, __resetCommerce, type Product } from '../src/features/commerce/commerceService.js';
import { subscribeToProduct, registerSubscriptionRecurrence, __resetSubscriptions } from '../src/features/commerce/subscriptions.js';
import { processStripeEvent } from '../src/features/billing/billingService.js';

const T = 'default';
const ORG = 'org-bridge';
let stripe: http.Server; let priorBase: string | undefined;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerSubscriptionRecurrence(); // the boot-time bridge (commerce feature.ts does this live)
  // Mock Stripe: POST /v1/customers → a customer id; POST /v1/subscriptions → a subscription id.
  stripe = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/customers')) { res.end('{"id":"cus_test"}'); return; }
    if (req.url?.startsWith('/v1/subscriptions')) { res.end('{"id":"sub_test"}'); return; }
    res.statusCode = 404; res.end('{"error":{"message":"unmocked"}}');
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  priorBase = process.env.OPENWOP_STRIPE_API_BASE;
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (priorBase === undefined) delete process.env.OPENWOP_STRIPE_API_BASE; else process.env.OPENWOP_STRIPE_API_BASE = priorBase;
  await new Promise<void>((r) => stripe.close(() => r()));
});
beforeEach(async () => { await __resetCommerce(); await __resetSubscriptions(); });

const subProduct = (): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Coffee', price: 100, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'], savePercent: 10 } });
const invoicePaid = (eventId: string, invoiceId: string): Parameters<typeof processStripeEvent>[1] =>
  ({ id: eventId, type: 'invoice.paid', data: { object: { subscription: 'sub_test', id: invoiceId } } });

describe('MERCH-E full recurrence bridge (mock Stripe)', () => {
  it('live subscribe → invoice.paid drives the next period order; re-delivery is idempotent', async () => {
    const p = await subProduct();
    const { subscription } = await subscribeToProduct({ tenantId: T, orgId: ORG, createdBy: 'u', productId: p.productId, interval: 'monthly', stripeKey: 'sk_test_x' });
    expect(subscription.paymentMode).toBe('live');               // Stripe subscription created
    expect(subscription.stripeSubscriptionId).toBe('sub_test');  // via the mock
    const [first] = await listOrders(T, ORG);
    expect(first?.status).toBe('pending');                       // the first period order, awaiting its invoice
    expect((await listOrders(T, ORG))).toHaveLength(1);

    // ADR 0450 OQ3 — the FIRST invoice.paid is that pending order's payment, not a
    // second order. Before the adoption fix this step created order #2 and paid it,
    // stranding #1 as a permanent pending row; this line pinned that defect.
    expect((await processStripeEvent(T, invoicePaid('evt_1', 'inv_1'))).status).toBe('applied');
    expect((await listOrders(T, ORG))).toHaveLength(1);
    expect((await listOrders(T, ORG))[0]?.status).toBe('paid');

    // Re-delivery with a NEW event id but the SAME invoice is idempotent (no 2nd order).
    expect((await processStripeEvent(T, invoicePaid('evt_2', 'inv_1'))).status).toBe('applied');
    expect((await listOrders(T, ORG))).toHaveLength(1);

    // A genuinely new invoice ⇒ the next period's order, paid on arrival.
    await processStripeEvent(T, invoicePaid('evt_3', 'inv_2'));
    expect((await listOrders(T, ORG))).toHaveLength(2);
    expect((await listOrders(T, ORG)).every((o) => o.status === 'paid')).toBe(true);

    // And the one after that — the seam keeps driving period orders.
    await processStripeEvent(T, invoicePaid('evt_4', 'inv_3'));
    expect((await listOrders(T, ORG))).toHaveLength(3);
  });
});
