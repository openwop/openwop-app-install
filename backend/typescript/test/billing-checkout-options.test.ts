/**
 * ADR 0890 — operator-configured Checkout options on the ADR 0176 / 0419 billing
 * rail, asserted on the exact form the ONE Stripe client posts:
 *
 *  1. Every knob unset ⇒ the session is byte-for-byte the pre-0890 one (exact
 *     key set, so an added param cannot slip in).
 *  2. `OPENWOP_BILLING_CHECKOUT_TAX` — `automatic` sends Stripe Tax + billing-address
 *     collection + `customer_update[address]=auto`; `managed` sends
 *     `managed_payments[enabled]` and NONE of the params Stripe rejects with it.
 *  3. `OPENWOP_BILLING_ALLOW_PROMOTION_CODES` → `allow_promotion_codes=true`.
 *  4. `OPENWOP_BILLING_TRIAL_CARD=if_required` → a no-card trial that cancels at
 *     trial end — only when a trial actually applies.
 *  5. Keying: `plan:<tier>` / `bundle:<id>` beat `*`; a bare value means `*`; a
 *     value a knob does not accept is ignored (default session, never a guess).
 *  6. The boot warning for `managed` on an API version older than its GA.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __resetBilling, createCheckoutSession, checkoutOptionsFor, apiVersionPredatesManagedPayments, warnCheckoutConfigAtBoot,
} from '../src/features/billing/billingService.js';

const STRIPE_KEY = 'sk_test_options';
const URLS = { successUrl: 'https://x/s', cancelUrl: 'https://x/c' };
const OPTION_KEYS = ['OPENWOP_BILLING_CHECKOUT_TAX', 'OPENWOP_BILLING_ALLOW_PROMOTION_CODES', 'OPENWOP_BILLING_TRIAL_CARD'];
const ENV_KEYS = [
  'OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_TRIAL_DAYS',
  'OPENWOP_BILLING_BUNDLE_ONETIME', 'OPENWOP_BILLING_TOKEN_PACK_PRICES', 'OPENWOP_STRIPE_API_BASE', ...OPTION_KEYS,
];
/** Params Stripe rejects on a Managed Payments session (docs.stripe.com/payments/
 *  managed-payments/update-checkout § "Remove unsupported parameters"). */
const MANAGED_FORBIDDEN = [
  'automatic_tax', 'tax_id_collection', 'payment_method_types', 'payment_method_configuration', 'excluded_payment_method_types',
  'customer_update', 'shipping_address_collection', 'shipping_options', 'adaptive_pricing', 'invoice_creation',
  'subscription_data[default_tax_rates]', 'subscription_data[application_fee_percent]', 'subscription_data[on_behalf_of]',
  'subscription_data[transfer_data]', 'subscription_data[invoice_settings]', 'payment_intent_data',
];

let server: http.Server;
let stripe: http.Server;
const posts: { path: string; body: string }[] = [];
let seq = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro' });
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm', price_agents: 'agents', price_mkt: 'marketing' });
  process.env.OPENWOP_BILLING_BUNDLE_ONETIME = JSON.stringify(['marketing']);
  process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_pack: 1_000_000 });
  process.env.OPENWOP_BILLING_TRIAL_DAYS = JSON.stringify({ 'plan:pro': 14, 'bundle:crm': 7 });
  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST') posts.push({ path: url, body: raw });
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_${++seq}` });
      if (req.method === 'POST' && url === '/v1/checkout/sessions') { const id = `cs_opt_${++seq}`; return send(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` }); }
      return send(404, { error: { message: `unmocked ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});
beforeEach(async () => {
  await __resetBilling();
  posts.length = 0;
  for (const k of OPTION_KEYS) delete process.env[k];
});

let tenantSeq = 0;
/** Check out `priceId` for a fresh tenant and return the session form Stripe got. */
async function checkoutForm(priceId: string): Promise<URLSearchParams> {
  await createCheckoutSession(`t-opt-${++tenantSeq}`, priceId, STRIPE_KEY, URLS);
  const body = posts.filter((p) => p.path === '/v1/checkout/sessions').at(-1)?.body;
  if (body === undefined) throw new Error('no checkout session was posted');
  return new URLSearchParams(body);
}
const keysOf = (form: URLSearchParams) => [...form.keys()].sort();
const hasPrefix = (form: URLSearchParams, prefix: string) => [...form.keys()].some((k) => k === prefix || k.startsWith(`${prefix}[`));

/** The pre-0890 session for a recurring bundle with a trial. */
const BASELINE_BUNDLE_TRIAL_KEYS = [
  'cancel_url', 'customer', 'line_items[0][price]', 'line_items[0][quantity]',
  'metadata[bundleId]', 'metadata[kind]', 'metadata[priceId]', 'metadata[tenantId]', 'mode',
  'subscription_data[metadata][bundleId]', 'subscription_data[metadata][kind]', 'subscription_data[metadata][priceId]',
  'subscription_data[metadata][tenantId]', 'subscription_data[trial_period_days]', 'success_url',
].sort();

describe('ADR 0890 — every knob unset sends the pre-0890 session', () => {
  it('a trial bundle, a trial plan and a one-time bundle carry no new param', async () => {
    expect(keysOf(await checkoutForm('price_crm'))).toEqual(BASELINE_BUNDLE_TRIAL_KEYS);
    const plan = await checkoutForm('price_pro');
    expect(keysOf(plan)).toEqual(BASELINE_BUNDLE_TRIAL_KEYS.filter((k) => !k.endsWith('[bundleId]')));
    const oneTime = await checkoutForm('price_mkt');
    expect(oneTime.get('mode')).toBe('payment');
    expect(keysOf(oneTime)).toEqual([
      'cancel_url', 'customer', 'line_items[0][price]', 'line_items[0][quantity]',
      'metadata[bundleId]', 'metadata[kind]', 'metadata[priceId]', 'metadata[tenantId]', 'mode', 'success_url',
    ]);
  });
  it('an explicit default on every knob is the same as unset', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = 'none';
    process.env.OPENWOP_BILLING_ALLOW_PROMOTION_CODES = 'false';
    process.env.OPENWOP_BILLING_TRIAL_CARD = 'required';
    expect(keysOf(await checkoutForm('price_crm'))).toEqual(BASELINE_BUNDLE_TRIAL_KEYS);
  });
});

describe('ADR 0890 — OPENWOP_BILLING_CHECKOUT_TAX', () => {
  it('automatic: Stripe Tax, a required billing address, saved onto the existing customer', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = JSON.stringify({ 'bundle:crm': 'automatic' });
    const form = await checkoutForm('price_crm');
    expect(form.get('automatic_tax[enabled]')).toBe('true');
    expect(form.get('billing_address_collection')).toBe('required');
    expect(form.get('customer_update[address]')).toBe('auto');
    expect(form.get('customer')).toMatch(/^cus_/);
    expect(hasPrefix(form, 'managed_payments')).toBe(false);
    expect(keysOf(form)).toEqual([...BASELINE_BUNDLE_TRIAL_KEYS, 'automatic_tax[enabled]', 'billing_address_collection', 'customer_update[address]'].sort());
  });
  it('managed: managed_payments only, and none of the params Stripe rejects with it', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = JSON.stringify({ 'bundle:crm': 'managed' });
    process.env.OPENWOP_BILLING_ALLOW_PROMOTION_CODES = 'true';
    process.env.OPENWOP_BILLING_TRIAL_CARD = 'if_required';
    const form = await checkoutForm('price_crm');
    expect(form.get('managed_payments[enabled]')).toBe('true');
    for (const p of MANAGED_FORBIDDEN) expect(hasPrefix(form, p), p).toBe(false);
    expect(form.get('billing_address_collection')).toBeNull();
    expect(keysOf(form)).toEqual([
      ...BASELINE_BUNDLE_TRIAL_KEYS, 'managed_payments[enabled]', 'allow_promotion_codes',
      'payment_method_collection', 'subscription_data[trial_settings][end_behavior][missing_payment_method]',
    ].sort());
  });
  it('managed on a one-time (payment-mode) bundle is still managed and still clean', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = 'managed';
    const form = await checkoutForm('price_mkt');
    expect(form.get('mode')).toBe('payment');
    expect(form.get('managed_payments[enabled]')).toBe('true');
    for (const p of MANAGED_FORBIDDEN) expect(hasPrefix(form, p), p).toBe(false);
  });
  it('a per-target key beats `*`, and a target with no key falls back to `*`', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = JSON.stringify({ '*': 'automatic', 'bundle:crm': 'managed', 'plan:pro': 'none' });
    expect((await checkoutForm('price_crm')).get('managed_payments[enabled]')).toBe('true');
    const agents = await checkoutForm('price_agents');
    expect(agents.get('automatic_tax[enabled]')).toBe('true');
    const pro = await checkoutForm('price_pro');
    expect(hasPrefix(pro, 'automatic_tax') || hasPrefix(pro, 'managed_payments')).toBe(false);
  });
  it('token packs keep the pre-0890 session even under `*`', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = 'managed';
    process.env.OPENWOP_BILLING_ALLOW_PROMOTION_CODES = 'true';
    const pack = await checkoutForm('price_pack');
    expect(pack.get('mode')).toBe('payment');
    expect(hasPrefix(pack, 'managed_payments') || pack.has('allow_promotion_codes')).toBe(false);
  });
  it('a value the knob does not accept is ignored — the default, never a guessed mode', async () => {
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = JSON.stringify({ 'bundle:crm': 'manged', '*': 'automatic' });
    expect(checkoutOptionsFor({ bundleId: 'crm' }).tax).toBe('automatic'); // typo dropped → `*`
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = 'stripe-tax';
    expect(checkoutOptionsFor({ bundleId: 'crm' }).tax).toBe('none');
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = '{not json';
    expect(keysOf(await checkoutForm('price_crm'))).toEqual(BASELINE_BUNDLE_TRIAL_KEYS);
  });
});

describe('ADR 0890 — OPENWOP_BILLING_ALLOW_PROMOTION_CODES', () => {
  it('per bundle: true on that bundle only', async () => {
    process.env.OPENWOP_BILLING_ALLOW_PROMOTION_CODES = JSON.stringify({ 'bundle:crm': true });
    expect((await checkoutForm('price_crm')).get('allow_promotion_codes')).toBe('true');
    expect((await checkoutForm('price_agents')).has('allow_promotion_codes')).toBe(false);
  });
  it('a bare `true` applies to plans and bundles; a string "yes" is not a boolean', async () => {
    process.env.OPENWOP_BILLING_ALLOW_PROMOTION_CODES = 'true';
    expect((await checkoutForm('price_pro')).get('allow_promotion_codes')).toBe('true');
    process.env.OPENWOP_BILLING_ALLOW_PROMOTION_CODES = JSON.stringify({ '*': 'yes' });
    expect((await checkoutForm('price_agents')).has('allow_promotion_codes')).toBe(false);
  });
});

describe('ADR 0890 — OPENWOP_BILLING_TRIAL_CARD', () => {
  it('if_required on a trial: no card up front, and the trial cancels without one', async () => {
    process.env.OPENWOP_BILLING_TRIAL_CARD = JSON.stringify({ 'bundle:crm': 'if_required' });
    const form = await checkoutForm('price_crm');
    expect(form.get('subscription_data[trial_period_days]')).toBe('7');
    expect(form.get('payment_method_collection')).toBe('if_required');
    expect(form.get('subscription_data[trial_settings][end_behavior][missing_payment_method]')).toBe('cancel');
  });
  it('if_required with no trial is ignored — a paid subscription always collects a card', async () => {
    process.env.OPENWOP_BILLING_TRIAL_CARD = 'if_required';
    const agents = await checkoutForm('price_agents'); // no trial configured
    expect(agents.has('subscription_data[trial_period_days]')).toBe(false);
    expect(agents.has('payment_method_collection')).toBe(false);
    expect(hasPrefix(agents, 'subscription_data[trial_settings]')).toBe(false);
    const oneTime = await checkoutForm('price_mkt'); // payment mode never trials
    expect(oneTime.has('payment_method_collection')).toBe(false);
  });
  it('applies to a plan trial through the same path', async () => {
    process.env.OPENWOP_BILLING_TRIAL_CARD = JSON.stringify({ 'plan:pro': 'if_required' });
    const form = await checkoutForm('price_pro');
    expect(form.get('subscription_data[trial_period_days]')).toBe('14');
    expect(form.get('payment_method_collection')).toBe('if_required');
  });
});

describe('ADR 0890 — the managed-payments API-version boot warning', () => {
  it('compares the date prefix of the version against the dahlia GA', () => {
    expect(apiVersionPredatesManagedPayments('2025-12-15.clover')).toBe(true);
    expect(apiVersionPredatesManagedPayments('2026-02-25.preview')).toBe(true);
    expect(apiVersionPredatesManagedPayments('2026-04-22.dahlia')).toBe(false);
    expect(apiVersionPredatesManagedPayments('2026-09-30.dahlia')).toBe(false);
  });
  it('warns only when a managed checkout is configured on an older version', () => {
    expect(warnCheckoutConfigAtBoot('2025-12-15.clover')).toBe(false); // nothing managed
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = JSON.stringify({ 'bundle:crm': 'automatic' });
    expect(warnCheckoutConfigAtBoot('2025-12-15.clover')).toBe(false);
    process.env.OPENWOP_BILLING_CHECKOUT_TAX = JSON.stringify({ 'bundle:crm': 'managed' });
    expect(warnCheckoutConfigAtBoot('2025-12-15.clover')).toBe(true);
    expect(warnCheckoutConfigAtBoot('2026-04-22.dahlia')).toBe(false);
  });
});
