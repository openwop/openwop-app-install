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
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createCheckoutSession } from '../src/features/billing/billingService.js';
import { createStripePortalSession, getStripePaymentIntent, toStripeMinorUnits } from '../src/features/billing/stripeApi.js';
import { createProduct, createOrder, markAsPaid, __resetCommerce } from '../src/features/commerce/commerceService.js';

let sg: http.Server;
let lastReq: { method?: string; path?: string; auth?: string; stripeVersion?: string | string[]; body?: string } = {};
let respond: (req: { path: string }) => { status: number; body: Record<string, unknown> };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // The config-driven price catalog (R-1.2 — no baked price IDs).
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro' });
  process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_pack_100k: 100000 });
  // Boot the app once so DurableCollections/persistence init (service-level tests).
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });

  sg = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastReq = { method: req.method, path: req.url, auth: req.headers.authorization, stripeVersion: req.headers['stripe-version'], body: raw };
      const out = respond({ path: req.url ?? '' });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.OPENWOP_STRIPE_API_BASE;
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
    ).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('other Stripe errors surface Stripe\'s message only', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'No such price: price_pro' } } });
    await expect(
      createCheckoutSession('t-live', 'price_pro', 'sk_test_key', { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }),
    ).rejects.toMatchObject({ code: 'internal_error', message: expect.stringContaining('No such price') });
  });
});

describe('LIVE billing portal session', () => {
  it('POSTs the stored customer and returns Stripe\'s url', async () => {
    respond = () => ({ status: 200, body: { url: 'https://billing.stripe.com/p/session/real_ps_1' } });
    const out = await createStripePortalSession('sk_test_key', 'cus_123', 'https://app.example/billing');
    expect(out.url).toBe('https://billing.stripe.com/p/session/real_ps_1');
    const form = new URLSearchParams(lastReq.body);
    expect(form.get('customer')).toBe('cus_123');
  });
});

describe('commerce markAsPaid — paymentIntent verification', () => {
  const T = 't-pay';
  const ORG = 'o1';

  async function pendingOrder(price: number, currency = 'usd'): Promise<string> {
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u1', type: 'digital', name: 'Widget', price, currency });
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u1', lines: [{ productId: p.productId, quantity: 1 }] });
    return o.orderId;
  }

  beforeAll(async () => { await __resetCommerce(); });

  it('verified success: intent succeeded + exact amount/currency ⇒ paid', async () => {
    const orderId = await pendingOrder(49.99);
    respond = ({ path }) => {
      expect(path).toContain('/v1/payment_intents/pi_ok');
      return { status: 200, body: { id: 'pi_ok', status: 'succeeded', amount: 4999, currency: 'usd' } };
    };
    const o = await markAsPaid(T, ORG, orderId, 'pi_ok', { stripeKey: 'sk_test_key' });
    expect(o?.status).toBe('paid');
  });

  it('a non-succeeded intent 409s and the order stays pending', async () => {
    const orderId = await pendingOrder(10);
    respond = () => ({ status: 200, body: { id: 'pi_x', status: 'requires_payment_method', amount: 1000, currency: 'usd' } });
    await expect(markAsPaid(T, ORG, orderId, 'pi_x', { stripeKey: 'sk_test_key' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('an amount mismatch 409s (minor-units exact)', async () => {
    const orderId = await pendingOrder(10);
    respond = () => ({ status: 200, body: { id: 'pi_y', status: 'succeeded', amount: 999, currency: 'usd' } });
    await expect(markAsPaid(T, ORG, orderId, 'pi_y', { stripeKey: 'sk_test_key' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('a currency mismatch always hard-fails', async () => {
    const orderId = await pendingOrder(10, 'usd');
    respond = () => ({ status: 200, body: { id: 'pi_z', status: 'succeeded', amount: 1000, currency: 'eur' } });
    await expect(markAsPaid(T, ORG, orderId, 'pi_z', { stripeKey: 'sk_test_key' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('keyless mode keeps the honest demo posture (recorded, unverified)', async () => {
    const orderId = await pendingOrder(10);
    respond = () => { throw new Error('Stripe must NOT be called keyless'); };
    const o = await markAsPaid(T, ORG, orderId, 'pi_demo', {});
    expect(o?.status).toBe('paid');
  });
});

describe('minor-units conversion', () => {
  it('2-decimal currencies ×100; zero-decimal pass through', () => {
    expect(toStripeMinorUnits(49.99, 'usd')).toBe(4999);
    expect(toStripeMinorUnits(1000, 'jpy')).toBe(1000);
  });

  it('getStripePaymentIntent projects status/amount/currency', async () => {
    respond = () => ({ status: 200, body: { id: 'pi_p', status: 'succeeded', amount: 123, currency: 'usd' } });
    expect(await getStripePaymentIntent('sk_test_key', 'pi_p')).toEqual({ status: 'succeeded', amount: 123, currency: 'usd' });
  });
});
