/**
 * ADR 0176 — Subscriptions & Billing. Verifies the Stripe signature check, the
 * idempotent webhook processor (subscription lifecycle + token-pack credit), the R-1
 * cutover importer (Stripe ids preserved verbatim), the central entitlement resolver
 * (unrestricted when off), and balance draw-down. Boots the app for host-ext persistence.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  verifyStripeSignature, processStripeEvent, importBillingState, resolveEntitlements,
  getSubscription, getBalance, drawFromBalance, createCheckoutSession, planLimits, planFeatures,
  setSeats, createBillingCoupon, billingCouponDiscount, generateInvoice, getInvoice, listInvoices, __resetBilling,
} from '../src/features/billing/billingService.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro', price_team: 'team' });
  process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_pack_100k: 100000 });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const sig = (ts: number, b: string) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${b}`).digest('hex')}`;
  it('accepts a good signature, rejects tamper/stale/missing', () => {
    expect(verifyStripeSignature({ signingSecret: secret, signatureHeader: sig(t, body), rawBody: body, now }).ok).toBe(true);
    expect(verifyStripeSignature({ signingSecret: secret, signatureHeader: sig(t, body), rawBody: body + 'x', now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyStripeSignature({ signingSecret: secret, signatureHeader: sig(t - 1000, body), rawBody: body, now })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyStripeSignature({ signingSecret: secret, signatureHeader: undefined, rawBody: body, now })).toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('processStripeEvent', () => {
  it('applies a subscription update (Stripe ids + plan preserved) and is idempotent', async () => {
    await __resetBilling();
    const event = {
      id: 'evt_sub_1', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_123', customer: 'cus_abc', status: 'active', items: { data: [{ price: { id: 'price_team' } }] } } },
    };
    expect((await processStripeEvent('t1', event)).status).toBe('applied');
    const sub = await getSubscription('t1');
    expect(sub).toMatchObject({ stripeSubscriptionId: 'sub_123', stripeCustomerId: 'cus_abc', stripePriceId: 'price_team', planTier: 'team', status: 'active' });
    // replay of the same event id → duplicate, no double-apply
    expect((await processStripeEvent('t1', event)).status).toBe('duplicate');
  });

  it('credits the prepaid token balance on a token-pack checkout (idempotent)', async () => {
    await __resetBilling();
    const event = { id: 'evt_pack_1', type: 'checkout.session.completed', data: { object: { customer: 'cus_x', priceId: 'price_pack_100k' } } };
    expect((await processStripeEvent('t2', event)).status).toBe('applied');
    expect((await getBalance('t2')).totalAvailable).toBe(100000);
    // retry does not double-credit
    await processStripeEvent('t2', event);
    expect((await getBalance('t2')).totalAvailable).toBe(100000);
  });
});

describe('processStripeEvent — R-1 cutover hardening', () => {
  it('CONCURRENT dual-endpoint delivery credits a token pack exactly once (CAS)', async () => {
    await __resetBilling();
    const event = { id: 'evt_race', type: 'checkout.session.completed', data: { object: { customer: 'cus_r', priceId: 'price_pack_100k' } } };
    // Both cutover endpoints deliver the same event at once — a get+put guard would
    // double-credit; the CAS claim lets exactly one win.
    const [a, b] = await Promise.all([processStripeEvent('tr', event), processStripeEvent('tr', event)]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'duplicate']);
    expect((await getBalance('tr')).totalAvailable).toBe(100000);
  });

  it('reads current_period_{start,end} from the subscription ITEM (2025-12-15.clover shape) + trial + default PM', async () => {
    await __resetBilling();
    const start = 1_800_000_000, end = 1_802_678_400, trial = 1_801_000_000;
    const event = {
      id: 'evt_clover', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_cl', customer: 'cus_cl', status: 'trialing', trial_end: trial, default_payment_method: 'pm_card_1', latest_invoice: 'in_cl',
        items: { data: [{ price: { id: 'price_team' }, current_period_start: start, current_period_end: end }] } } },
    };
    expect((await processStripeEvent('tc', event)).status).toBe('applied');
    const sub = await getSubscription('tc');
    expect(sub).toMatchObject({
      currentPeriodStart: new Date(start * 1000).toISOString(),
      currentPeriodEnd: new Date(end * 1000).toISOString(),
      trialEnd: new Date(trial * 1000).toISOString(),
      defaultPaymentMethodId: 'pm_card_1', latestInvoiceId: 'in_cl', status: 'trialing', planTier: 'team',
    });
  });

  it('an unmapped price keeps the existing tier — never a silent "pro" default', async () => {
    await __resetBilling();
    await processStripeEvent('tu', { id: 'evt_u1', type: 'customer.subscription.updated', data: { object: { id: 's', customer: 'c', status: 'active', items: { data: [{ price: { id: 'price_team' } }] } } } });
    // A later event whose price isn't in the catalog must not silently flip the tier to 'pro'.
    await processStripeEvent('tu', { id: 'evt_u2', type: 'customer.subscription.updated', data: { object: { id: 's', customer: 'c', status: 'active', items: { data: [{ price: { id: 'price_unknown' } }] } } } });
    expect((await getSubscription('tu')).planTier).toBe('team');
  });

  it('records the latest invoice on invoice.created / .payment_failed (parity)', async () => {
    await __resetBilling();
    expect((await processStripeEvent('ti', { id: 'evt_i1', type: 'invoice.created', data: { object: { id: 'in_1', customer: 'c' } } })).status).toBe('applied');
    expect((await getSubscription('ti')).latestInvoiceId).toBe('in_1');
    expect((await processStripeEvent('ti', { id: 'evt_i2', type: 'invoice.payment_failed', data: { object: { id: 'in_2', customer: 'c' } } })).status).toBe('applied');
    expect((await getSubscription('ti')).latestInvoiceId).toBe('in_2');
  });

  it('payment_method.attached adopts the FIRST card, never clobbers an existing default; .detached clears', async () => {
    await __resetBilling();
    // First card → adopted as default.
    expect((await processStripeEvent('tp', { id: 'evt_pm1', type: 'payment_method.attached', data: { object: { id: 'pm_9', customer: 'c' } } })).status).toBe('applied');
    expect((await getSubscription('tp')).defaultPaymentMethodId).toBe('pm_9');
    // A SECOND attached card must NOT silently become the default (the sub event is authoritative).
    expect((await processStripeEvent('tp', { id: 'evt_pm1b', type: 'payment_method.attached', data: { object: { id: 'pm_10', customer: 'c' } } })).status).toBe('ignored');
    expect((await getSubscription('tp')).defaultPaymentMethodId).toBe('pm_9');
    // Detaching the default clears it.
    expect((await processStripeEvent('tp', { id: 'evt_pm2', type: 'payment_method.detached', data: { object: { id: 'pm_9', customer: 'c' } } })).status).toBe('applied');
    expect((await getSubscription('tp')).defaultPaymentMethodId).toBeUndefined();
  });
});

describe('R-1 importer + entitlements + balance', () => {
  it('imports subscriptions preserving Stripe ids verbatim', async () => {
    await __resetBilling();
    const r = await importBillingState({ subscriptions: [{ tenantId: 't3', planTier: 'pro', status: 'active', stripeCustomerId: 'cus_legacy', stripeSubscriptionId: 'sub_legacy', updatedAt: '' }], balances: [{ tenantId: 't3', purchasedTokensTotal: 5000, totalAvailable: 5000, updatedAt: '' }] });
    expect(r).toEqual({ subscriptions: 1, balances: 1 });
    expect(await getSubscription('t3')).toMatchObject({ stripeCustomerId: 'cus_legacy', stripeSubscriptionId: 'sub_legacy', planTier: 'pro' });
    expect((await getBalance('t3')).totalAvailable).toBe(5000);
  });
  it('entitlements are unrestricted when billing is off', async () => {
    expect(await resolveEntitlements('t3', false)).toEqual({ plan: 'free', allowedFeatures: '*', limits: {} });
  });
  it('draws from balance before the daily cap', async () => {
    await __resetBilling();
    await importBillingState({ balances: [{ tenantId: 't4', purchasedTokensTotal: 300, totalAvailable: 300, updatedAt: '' }] });
    expect(await drawFromBalance('t4', 200)).toBe(200);
    expect((await getBalance('t4')).totalAvailable).toBe(100);
    expect(await drawFromBalance('t4', 500)).toBe(100); // draws only what's left
    expect(await drawFromBalance('t4', 10)).toBe(0);
  });
});

describe('checkout session + plan limits (Phases 1/3)', () => {
  it('creates a demo checkout session for a configured price; rejects an unknown price', async () => {
    // Keyless (null Stripe key) → honest demo sentinel. The LIVE leg (real
    // Stripe API call) is covered in stripe-live-payments.test.ts against a
    // mock Stripe server (LEAK-11 — the old fabricated-URL live leg is gone).
    const s = await createCheckoutSession('t5', 'price_pro', null);
    expect(s.mode).toBe('demo');
    expect(s.url).toMatch(/^demo:checkout:/);
    expect(s.priceId).toBe('price_pro');
    await expect(createCheckoutSession('t5', 'price_unknown', null)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('seat sync, billing coupons, and invoice generation (deferred P2)', async () => {
    await __resetBilling();
    // seat sync
    const sub = await setSeats('t7', 5);
    expect(sub.quantity).toBe(5);
    // coupons
    await createBillingCoupon('t7', 'HALF', 'percentage', 50);
    await createBillingCoupon('t7', 'TEN', 'fixed', 10);
    expect(await billingCouponDiscount('t7', 'half', 100)).toBe(50);
    expect(await billingCouponDiscount('t7', 'TEN', 100)).toBe(10);
    expect(await billingCouponDiscount('t7', 'NOPE', 100)).toBe(0);
    // invoice
    const inv = await generateInvoice('t7', 250, 'USD');
    expect(inv.amount).toBe(250);
    expect(inv.markdown).toMatch(/Total: 250 USD/);
    expect(inv.markdown).toMatch(/5 seats/);
    expect((await getInvoice('t7', inv.invoiceId))?.invoiceId).toBe(inv.invoiceId);
    expect(await getInvoice('t7', 'inv:nope')).toBeNull();
    expect((await listInvoices('t7')).length).toBe(1);
  });

  it('planFeatures narrows allowedFeatures only from explicit operator config (A2)', async () => {
    delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
    expect(planFeatures('free')).toBe('*'); // absent config ⇒ unrestricted
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['crm', 'forms'], pro: '*' });
    try {
      expect(planFeatures('free')).toEqual(['crm', 'forms']);
      expect(planFeatures('pro')).toBe('*');
      expect(planFeatures('team')).toBe('*'); // plan not listed ⇒ unrestricted
      // resolveEntitlements carries the narrowed list only when billing is on.
      // ADR 0419 § Correction (#2348): the resolved list is the plan's features
      // UNIONED with every non-sellable toggle — a narrowed plan can only ever
      // exclude features that are actually for sale (paid-feature-bundles.test.ts
      // pins the sellable/non-sellable split; here we pin plan-list carry + shape).
      await __resetBilling();
      const resolved = (await resolveEntitlements('t8', true)).allowedFeatures; // no sub ⇒ free
      expect(Array.isArray(resolved)).toBe(true); // narrowed, not '*'
      expect(resolved).toEqual(expect.arrayContaining(['crm', 'forms'])); // the operator's plan list carries
      expect((await resolveEntitlements('t8', false)).allowedFeatures).toBe('*'); // billing off ⇒ unrestricted
      process.env.OPENWOP_BILLING_PLAN_FEATURES = 'not-json';
      expect(planFeatures('free')).toBe('*'); // invalid config fails open
      process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['crm', 42] });
      expect(planFeatures('free')).toBe('*'); // partially-invalid array must not silently narrow
      process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: [] });
      expect(planFeatures('free')).toEqual([]); // explicit empty allowlist IS honored
    } finally {
      delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
    }
  });

  it('resolveEntitlements surfaces per-tier limits from config when billing is on', async () => {
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { workflowRuns: 100 }, team: { workflowRuns: 9999 } });
    await __resetBilling();
    await processStripeEvent('t6', { id: 'evt_lim', type: 'customer.subscription.updated', data: { object: { id: 'sub_l', customer: 'cus_l', status: 'active', items: { data: [{ price: { id: 'price_team' } }] } } } });
    const ent = await resolveEntitlements('t6', true);
    expect(ent.plan).toBe('team');
    expect(ent.limits).toEqual({ workflowRuns: 9999 });
    expect(planLimits('free')).toEqual({ workflowRuns: 100 });
  });
});
