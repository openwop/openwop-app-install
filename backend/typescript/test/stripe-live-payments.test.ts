/**
 * LEAK-11 (ADR 0176/0177 correction notes) — REAL Stripe payments against a
 * mock Stripe HTTP server (the email-adapter test precedent).
 *
 *  - checkout session: LIVE mode POSTs /v1/checkout/sessions (form-encoded,
 *    Bearer key, subscription vs payment mode inferred from the catalog) and
 *    returns STRIPE'S OWN id + hosted URL — the old code fabricated a
 *    checkout.stripe.com URL that 404'd at Stripe.
 *  - portal session: LIVE mode POSTs /v1/billing_portal/sessions.
 *  - commerce markAsPaid: with a key, the paymentIntent is VERIFIED —
 *    succeeded + exact minor-units amount + currency, each mismatch a 409.
 *  - failure honesty: Stripe 401 → credential_unavailable; other errors carry
 *    Stripe's message only (never the key).
 *
 * The mock server only RECORDS calls (`calls`); it never asserts or throws
 * inside its handler, because an exception there is an uncaught server error
 * (the case sees a dropped socket, not the assertion). Each refusal asserts
 * the 409 code AND reads the order back as still `pending`, so a refusal that
 * flipped the order before throwing reds. Minor units use 0.29 / 19.99, whose
 * ×100 is NOT exact in IEEE754 (49.99 is), so a `Math.floor` conversion reds
 * (8fw3g2-slp-minor was vacuous in round 1 on 49.99 alone).
 *
 * Persistence: `initHostExtPersistence(openStorage('memory://'))`, the
 * subscription-bridge-integration precedent, instead of booting `createApp()`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createCheckoutSession } from '../src/features/billing/billingService.js';
import { createStripePortalSession, getStripePaymentIntent, toStripeMinorUnits } from '../src/features/billing/stripeApi.js';
import { createProduct, createOrder, getOrder, markAsPaid, __resetCommerce } from '../src/features/commerce/commerceService.js';

interface StripeCall { method?: string; path?: string; auth?: string; stripeVersion?: string | string[]; body?: string }
let sg: http.Server;
const calls: StripeCall[] = [];
let lastReq: StripeCall = {};
let respond: (req: { path: string }) => { status: number; body: Record<string, unknown> };

const ENV_KEYS = ['OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_BILLING_TOKEN_PACK_PRICES', 'OPENWOP_STRIPE_API_BASE'] as const;
const priorEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  // The config-driven price catalog (R-1.2 — no baked price IDs).
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro' });
  process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_pack_100k: 100000 });
  initHostExtPersistence(await openStorage('memory://'));

  sg = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastReq = { method: req.method, path: req.url, auth: req.headers.authorization, stripeVersion: req.headers['stripe-version'], body: raw };
      calls.push(lastReq);
      const out = respond({ path: req.url ?? '' });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const [k, v] of priorEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((r) => sg.close(() => r()));
});

describe('LIVE checkout session — real Stripe API call', () => {
  it('POSTs form-encoded with the Bearer key; returns Stripe\'s own id + url; token pack ⇒ mode=payment', async () => {
    respond = () => ({ status: 200, body: { id: 'cs_stripe_real_1', url: 'https://checkout.stripe.com/c/pay/cs_stripe_real_1' } });
    const s = await createCheckoutSession('t-live', 'price_pack_100k', 'sk_test_key', {
      successUrl: 'https://app.example/billing?checkout=success',
      cancelUrl: 'https://app.example/billing?checkout=cancelled',
    });
    expect(s.mode).toBe('live');
    expect(s.sessionId).toBe('cs_stripe_real_1'); // STRIPE'S id, not locally minted
    expect(s.url).toBe('https://checkout.stripe.com/c/pay/cs_stripe_real_1');
    expect(lastReq.auth).toBe('Bearer sk_test_key');
    expect(lastReq.stripeVersion).toBe('2025-12-15.clover'); // R-1: API version pinned to MyndHyve's
    expect(lastReq.path).toBe('/v1/checkout/sessions');
    const form = new URLSearchParams(lastReq.body);
    expect(form.get('mode')).toBe('payment'); // token pack = one-time
    expect(form.get('line_items[0][price]')).toBe('price_pack_100k');
    expect(form.get('success_url')).toContain('checkout=success');
  });

  it('a plan price ⇒ mode=subscription', async () => {
    respond = () => ({ status: 200, body: { id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' } });
    await createCheckoutSession('t-live', 'price_pro', 'sk_test_key', { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    expect(new URLSearchParams(lastReq.body).get('mode')).toBe('subscription');
  });

  it('Stripe 401 → credential_unavailable (actionable, key never echoed)', async () => {
    respond = () => ({ status: 401, body: { error: { message: 'Invalid API Key provided' } } });
    await expect(
      createCheckoutSession('t-live', 'price_pro', 'sk_bad', { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }),
    ).rejects.toMatchObject({ code: 'credential_unavailable', message: expect.not.stringContaining('sk_bad') });
    expect(lastReq.auth).toBe('Bearer sk_bad'); // the key WAS sent, and is still not echoed back
  });

  it('other Stripe errors surface Stripe\'s message only', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'No such price: price_pro' } } });
    await expect(
      createCheckoutSession('t-live', 'price_pro', 'sk_test_key', { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }),
    ).rejects.toMatchObject({ code: 'internal_error', message: expect.stringContaining('No such price') });
    await expect(
      createCheckoutSession('t-live', 'price_pro', 'sk_test_key', { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('sk_test_key') });
  });
});

describe('LIVE billing portal session', () => {
  it('POSTs the stored customer and returns Stripe\'s url', async () => {
    respond = () => ({ status: 200, body: { url: 'https://billing.stripe.com/p/session/real_ps_1' } });
    const out = await createStripePortalSession('sk_test_key', 'cus_123', 'https://app.example/billing');
    expect(out.url).toBe('https://billing.stripe.com/p/session/real_ps_1');
    expect(lastReq.method).toBe('POST');
    expect(lastReq.path).toBe('/v1/billing_portal/sessions');
    expect(lastReq.auth).toBe('Bearer sk_test_key');
    const form = new URLSearchParams(lastReq.body);
    expect(form.get('customer')).toBe('cus_123');
  });
});

describe('commerce markAsPaid — paymentIntent verification', () => {
  const T = 't-pay';
  const ORG = 'o1';

  /** Every refusal leaves the order exactly where it was. */
  async function expectStillPending(orderId: string): Promise<void> {
    expect((await getOrder(T, ORG, orderId))?.status).toBe('pending');
  }

  async function pendingOrder(price: number, currency = 'usd'): Promise<string> {
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u1', type: 'digital', name: 'Widget', price, currency });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u1', lines: [{ productId: p.productId, quantity: 1 }] });
    return o.orderId;
  }

  beforeAll(async () => { await __resetCommerce(); });

  it('verified success: intent succeeded + exact amount/currency ⇒ paid', async () => {
    const orderId = await pendingOrder(49.99);
    // ADR 0875 D3 — a real intent this host created carries its order's metadata.
    respond = () => ({ status: 200, body: { id: 'pi_ok', status: 'succeeded', amount: 4999, currency: 'usd', metadata: { orderId, tenantId: T, orgId: ORG } } });
    const o = await markAsPaid(T, ORG, orderId, 'pi_ok', { stripeKey: 'sk_test_key' });
    expect(o?.status).toBe('paid');
    expect(lastReq.method).toBe('GET');
    expect(lastReq.path).toBe('/v1/payment_intents/pi_ok');
    expect(lastReq.auth).toBe('Bearer sk_test_key');
    expect((await getOrder(T, ORG, orderId))?.status).toBe('paid'); // persisted, not just returned
  });

  it('a non-succeeded intent 409s and the order stays pending', async () => {
    const orderId = await pendingOrder(10);
    respond = () => ({ status: 200, body: { id: 'pi_x', status: 'requires_payment_method', amount: 1000, currency: 'usd', metadata: { orderId, tenantId: T, orgId: ORG } } });
    await expect(markAsPaid(T, ORG, orderId, 'pi_x', { stripeKey: 'sk_test_key' })).rejects.toMatchObject({
      code: 'validation_error', httpStatus: 409, message: expect.stringMatching(/'requires_payment_method', not succeeded/),
    });
    await expectStillPending(orderId);
  });

  it('an amount mismatch 409s (minor-units exact)', async () => {
    const orderId = await pendingOrder(10);
    respond = () => ({ status: 200, body: { id: 'pi_y', status: 'succeeded', amount: 999, currency: 'usd', metadata: { orderId, tenantId: T, orgId: ORG } } });
    await expect(markAsPaid(T, ORG, orderId, 'pi_y', { stripeKey: 'sk_test_key' })).rejects.toMatchObject({
      code: 'validation_error', httpStatus: 409, message: expect.stringMatching(/Payment amount 999 does not match the order charge \(1000 minor units\)/),
    });
    await expectStillPending(orderId);
  });

  it('a currency mismatch always hard-fails', async () => {
    const orderId = await pendingOrder(10, 'usd');
    respond = () => ({ status: 200, body: { id: 'pi_z', status: 'succeeded', amount: 1000, currency: 'eur', metadata: { orderId, tenantId: T, orgId: ORG } } });
    await expect(markAsPaid(T, ORG, orderId, 'pi_z', { stripeKey: 'sk_test_key' })).rejects.toMatchObject({
      code: 'validation_error', httpStatus: 409, message: expect.stringMatching(/Payment currency 'eur' does not match the order currency 'usd'/i),
    });
    await expectStillPending(orderId);
  });

  it('keyless mode keeps the honest demo posture (recorded, unverified)', async () => {
    const orderId = await pendingOrder(10);
    // A call would get a succeeded intent; the assertion is that none is made.
    respond = () => ({ status: 200, body: { id: 'pi_demo', status: 'succeeded', amount: 1000, currency: 'usd' } });
    const before = calls.length;
    const o = await markAsPaid(T, ORG, orderId, 'pi_demo', {});
    expect(o?.status).toBe('paid');
    expect(calls.length, 'Stripe must NOT be called keyless').toBe(before);
  });
});

describe('minor-units conversion', () => {
  it('2-decimal currencies ×100; zero-decimal pass through', () => {
    expect(toStripeMinorUnits(49.99, 'usd')).toBe(4999);
    // ×100 is inexact for these (28.999…, 1998.999…): rounding, not truncation.
    expect(toStripeMinorUnits(0.29, 'usd')).toBe(29);
    expect(toStripeMinorUnits(19.99, 'usd')).toBe(1999);
    expect(toStripeMinorUnits(1000, 'jpy')).toBe(1000);
  });

  it('getStripePaymentIntent projects status/amount/currency', async () => {
    respond = () => ({ status: 200, body: { id: 'pi_p', status: 'succeeded', amount: 123, currency: 'usd', metadata: { orderId: 'ord:1', n: 7 } } });
    // ADR 0875 D3 — metadata rides through (string values only; it binds the intent to its order).
    expect(await getStripePaymentIntent('sk_test_key', 'pi_p')).toEqual({ status: 'succeeded', amount: 123, currency: 'usd', metadata: { orderId: 'ord:1' } });
  });
});
