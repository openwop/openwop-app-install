/**
 * ADR 0877 — who may take live money on a storefront, and on whose account.
 *
 * The user decision (2026-10-12): live checkout on the operator's PLATFORM Stripe
 * account is for the operator's own tenants (superadmin) and billing-exempt
 * tenants only. Every other tenant must onboard a Connect account first; until
 * then its checkout is demo (no charge).
 *
 * Written RED against `origin/main` @ `1add18177`: there, a signed-in
 * non-operator tenant's public checkout opened a live Checkout Session on the
 * platform account. A mock Stripe server records every call, so "no charge" is
 * asserted as "no money-opening call reached Stripe", not as a response field.
 *
 * Tracker TST-BHA-2. Red when (each sabotage-witnessed, wave 62): the platform list
 * grants every tenant, or the billing-exempt list grants the platform lane; a seller
 * row's mode / transfers capability / region / toggle stops gating Connect; the
 * destination, `on_behalf_of`, storefront fee (default 2%, clamp 15%), subscription fee
 * percent or the per-order idempotency key is dropped from the Stripe call; a Connect
 * refund stops reversing the transfer or returning the fee; or an `in_` invoice order
 * reaches the refund call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { getOrder, markAsPaid, captureSavedPmFromPaidIntent } from '../src/features/commerce/commerceService.js';
import { sellers, accountIndex } from '../src/features/commerce-connect/stores.js';
import { startOnboarding, getStorefrontFeePct, setStorefrontFeePct, getApplicationFeePct } from '../src/features/commerce-connect/connectService.js';

let BASE: string; let server: http.Server; let stripe: http.Server; let n = 0;
interface StripeCall { method: string; path: string; form: URLSearchParams; idem?: string }
const calls: StripeCall[] = [];
interface Intent { amount: number; currency: string; status: string; metadata: Record<string, string>; transfer_data?: { destination: string } }
const intents = new Map<string, Intent>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const url = (req.url ?? '').replace(/^\/v\d+/, '');
      const idem = req.headers['idempotency-key'];
      calls.push({ method: req.method ?? '', path: url, form, ...(typeof idem === 'string' ? { idem } : {}) });
      const reply = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url === '/payment_intents') {
        const id = `pi_oc_${calls.length}`;
        const meta: Record<string, string> = {};
        for (const k of ['orderId', 'tenantId', 'orgId']) { const v = form.get(`metadata[${k}]`); if (v) meta[k] = v; }
        const dest = form.get('transfer_data[destination]');
        intents.set(id, { amount: Number(form.get('amount') ?? 0), currency: String(form.get('currency') ?? 'usd'), status: 'succeeded', metadata: meta, ...(dest ? { transfer_data: { destination: dest } } : {}) });
        reply(200, { id, status: 'succeeded' });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/payment_intents/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        const known = intents.get(id);
        if (!known) { reply(404, { error: { message: 'No such payment_intent' } }); return; }
        reply(200, { id, ...known });
        return;
      }
      if (url === '/checkout/sessions') { reply(200, { id: `cs_${calls.length}`, url: 'https://checkout.stripe.test/s' }); return; }
      if (url === '/customers') { reply(200, { id: `cus_${calls.length}` }); return; }
      if (url === '/refunds') { reply(200, { id: `re_${calls.length}`, status: 'succeeded' }); return; }
      if (url === '/accounts') { reply(200, { id: `acct_live_${calls.length}`, country: 'US' }); return; }
      if (url === '/account_links') { reply(200, { url: 'https://connect.stripe.test/onboard' }); return; }
      reply(200, { id: `obj_${calls.length}`, status: 'active' });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm', 'commerce-ucp', 'commerce-connect']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await setSecret('billing:stripe-key', 'sk_test_mock');
});
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
  delete process.env.OPENWOP_BILLING_EXEMPT_TENANTS;
  delete process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});
beforeEach(() => {
  delete process.env.OPENWOP_BILLING_EXEMPT_TENANTS;
  delete process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS;
});

/** Wire JSON, typed at each call site that reads a field (TST-BHA-2: no `any` client). */
type Json = Record<string, unknown>;
interface Res<T = Json> { status: number; body: T }
interface ErrBody { error?: string; message?: string; details?: { code?: string; reason?: string } }
interface Created { productId: string; orderId: string; quoteId: string; clientId: string; clientSecret: string; access_token: string; token: string; orgId: string }
interface Checkout { mode: 'demo' | 'live'; orderId: string; checkoutUrl?: string }
function client() {
  let cookie = '';
  const call = async <T = Json>(method: string, path: string, body?: unknown, bearer?: string): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T }; // wire JSON: the caller names the shape it reads
  };
  return {
    get: <T = Json>(p: string, bearer?: string) => call<T>('GET', p, undefined, bearer),
    post: <T = Json>(p: string, b?: unknown, bearer?: string) => call<T>('POST', p, b, bearer),
  };
}
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;
const pub = (orgId: string, s = ''): string => `/host/openwop-app/public-store/${encodeURIComponent(orgId)}${s}`;
const ucp = (orgId: string, s = ''): string => `/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}${s}`;

async function shop(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const tenantId = `org:a0877-${Date.now()}-${n++}`;
  const login = await owner.post('/host/openwop-app/test/login', { email: `a0877-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await owner.post<Created>('/host/openwop-app/orgs', { name: 'Eligibility Shop' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
/** ADR 0877 Q3 — the explicit platform list (superadmin ∪ this; never billing-exempt). */
const exempt = (...tenants: string[]): void => { process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS = tenants.join(','); };
async function onboarded(tenantId: string, over: Partial<Parameters<typeof sellers.put>[0]> = {}): Promise<string> {
  const acct = `acct_seller_${n++}`;
  const now = new Date().toISOString();
  await sellers.put({ tenantId, stripeAccountId: acct, onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true, region: 'US', capabilities: ['card_payments', 'transfers'], mode: 'live', createdAt: now, updatedAt: now, ...over });
  await accountIndex.put({ stripeAccountId: acct, tenantId });
  return acct;
}
/** Every Stripe call that OPENS money (a session, an intent, a subscription). */
const moneyCallsSince = (mark: number): StripeCall[] => calls.slice(mark).filter((x) => x.method === 'POST' && ['/checkout/sessions', '/payment_intents', '/subscriptions'].includes(x.path));

describe('ADR 0877 D1/D2 — the public checkout asks who may take live money', () => {
  it('a signed-in non-operator tenant gets a DEMO checkout: nothing reaches Stripe', async () => {
    const { owner, orgId } = await shop();
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const mark = calls.length;
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.mode).toBe('demo');
    expect(co.body.checkoutUrl).toBeUndefined();
    expect(moneyCallsSince(mark)).toEqual([]);
  });

  it('an explicitly listed operator tenant keeps the PLATFORM lane: no transfer, no fee', async () => {
    const { owner, orgId, tenantId } = await shop();
    exempt(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const mark = calls.length;
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.mode).toBe('live');
    const [session] = moneyCallsSince(mark);
    expect(session?.path).toBe('/checkout/sessions');
    expect(session!.form.get('payment_intent_data[transfer_data][destination]')).toBeNull();
    expect(session!.form.get('payment_intent_data[application_fee_amount]')).toBeNull();
  });

  it('Q3 — a billing-exempt but UNLISTED tenant gets demo (lifting limits never makes the operator merchant of record)', async () => {
    const { owner, orgId, tenantId } = await shop();
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = tenantId;
    process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS = 'some-other-tenant';
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const mark = calls.length;
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.body.mode).toBe('demo');
    expect(moneyCallsSince(mark)).toEqual([]);
  });

  it('an onboarded Connect seller gets a DESTINATION charge: transfer + on_behalf_of + fee on goods, no ccOrderId', async () => {
    const { owner, orgId, tenantId } = await shop();
    const acct = await onboarded(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const mark = calls.length;
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 2 }] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.mode).toBe('live');
    const [session] = moneyCallsSince(mark);
    expect(session!.form.get('payment_intent_data[transfer_data][destination]')).toBe(acct);
    expect(session!.form.get('payment_intent_data[on_behalf_of]')).toBe(acct);
    // 2% (the STOREFRONT default, Q1) of the GOODS total, minor units first: 2 × 25.00 = 5000 → 100.
    expect(session!.form.get('payment_intent_data[application_fee_amount]')).toBe('100');
    expect(session!.form.get('metadata[ccOrderId]')).toBeNull();
    expect(session!.form.get('payment_intent_data[metadata][ccOrderId]')).toBeNull();
    expect(session!.form.get('metadata[orderId]')).toBe(co.body.orderId);
    expect(session!.idem).toBe(`storefront:${co.body.orderId}`);
    expect((await getOrder(tenantId, orgId, co.body.orderId))?.settlement).toEqual({ kind: 'connect', destinationAccountId: acct });
  });

  it('an onboarded seller whose commerce-connect toggle is OFF falls back to demo', async () => {
    const { owner, orgId, tenantId } = await shop();
    await onboarded(tenantId);
    const d = getToggleDefault('commerce-connect')!;
    await saveConfig({ ...d, status: 'on', tenantOverrides: { [tenantId]: { status: 'off' } } }, 'test');
    try {
      const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
      const mark = calls.length;
      const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
      expect(co.body.mode).toBe('demo');
      expect(moneyCallsSince(mark)).toEqual([]);
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });

  it('a seller that is not ready (demo row, restricted, no transfers capability, no region) is demo', async () => {
    for (const over of [{ mode: 'demo' as const }, { onboardingState: 'restricted' as const, chargesEnabled: false }, { capabilities: ['card_payments'] }, { region: '' }]) {
      const { owner, orgId, tenantId } = await shop();
      await onboarded(tenantId, over);
      const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
      const mark = calls.length;
      const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
      expect(co.body.mode, JSON.stringify(over)).toBe('demo');
      expect(moneyCallsSince(mark), JSON.stringify(over)).toEqual([]);
    }
  });
});

describe('ADR 0877 D2 — the other three charge-opening lanes refuse a non-operator tenant too', () => {
  it('product subscription: no Stripe subscription for a non-operator tenant', async () => {
    const { owner, orgId } = await shop();
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Monthly', price: 9, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });
    const mark = calls.length;
    const sub = await owner.post<{ subscription: { paymentMode: string } }>(c(orgId, '/subscriptions'), { productId: p.body.productId, interval: 'monthly' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.subscription.paymentMode).toBe('demo');
    expect(moneyCallsSince(mark)).toEqual([]);
  });

  it('product subscription for a Connect seller carries transfer_data + application_fee_percent', async () => {
    const { owner, orgId, tenantId } = await shop();
    const acct = await onboarded(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Monthly', price: 9, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });
    const mark = calls.length;
    const sub = await owner.post<{ subscription: { paymentMode: string } }>(c(orgId, '/subscriptions'), { productId: p.body.productId, interval: 'monthly' });
    expect(sub.body.subscription.paymentMode).toBe('live');
    const [s] = moneyCallsSince(mark);
    expect(s?.path).toBe('/subscriptions');
    expect(s!.form.get('transfer_data[destination]')).toBe(acct);
    expect(s!.form.get('on_behalf_of')).toBe(acct);
    expect(s!.form.get('application_fee_percent')).toBe('2');
  });

  it('one-click: a parent paid on the platform lane cannot be charged after the lane changes (uniform 404, no intent)', async () => {
    const { owner, orgId, tenantId } = await shop();
    exempt(tenantId);
    const main = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
    const up = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Coaching', price: 50, currency: 'USD' });
    const email = `oc-${n++}@x.test`;
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email, lines: [{ productId: main.body.productId, quantity: 1 }], savePaymentMethod: true });
    expect(co.body.mode).toBe('live');
    const orderId: string = co.body.orderId;
    const pi = `pi_parent_${n++}`;
    intents.set(pi, { amount: 10000, currency: 'usd', status: 'succeeded', metadata: { orderId, tenantId, orgId } });
    await markAsPaid(tenantId, orgId, orderId, pi, { actor: 'test', stripeKey: 'sk_test_mock' });
    expect(await captureSavedPmFromPaidIntent((await getOrder(tenantId, orgId, orderId))!, { customer: `cus_${email}`, payment_method: `pm_${email}` })).toBe(true);
    const session = [...calls].reverse().find((x) => x.path === '/checkout/sessions' && x.form.get('metadata[orderId]') === orderId)!;
    const oc = new URL(String(session.form.get('success_url'))).searchParams.get('oc');
    // The tenant is no longer platform-eligible, and has onboarded Connect since.
    delete process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS;
    await onboarded(tenantId);
    const mark = calls.length;
    const r = await client().post(pub(orgId, `/orders/${encodeURIComponent(orderId)}/one-click`), { productId: up.body.productId, oc });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(moneyCallsSince(mark)).toEqual([]);
  });

  it('UCP /pay stays refused on a live host for a demo-lane tenant (never demo-settles an AP2 mandate)', async () => {
    const { owner, orgId } = await shop();
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const prov = await owner.post<Created>(c(orgId, '/ucp/clients'), { name: 'agent' });
    expect(prov.status, JSON.stringify(prov.body)).toBe(201);
    const tok = await client().post<Created>(ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    const bearer: string = tok.body.access_token;
    await client().post(ucp(orgId, '/cart/items'), { item_id: p.body.productId, quantity: 1 }, bearer);
    const co = await client().post<ErrBody>(ucp(orgId, '/checkout'), {}, bearer);
    expect(co.status, JSON.stringify(co.body)).toBe(409);
    expect(co.body.details?.code).toBe('live_payment_required');
  });
});

describe('ADR 0877 H1 — a demo-lane store on a live host can still settle by hand', () => {
  it('/pay accepts an offline (manual:) payment for a demo-lane order, and still verifies a pi_ id', async () => {
    const { owner, orgId } = await shop();
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.body.mode).toBe('demo');
    const paid = await owner.post<{ status: string; paymentVerification: string }>(c(orgId, `/orders/${encodeURIComponent(co.body.orderId)}/pay`), { paymentIntentId: 'manual:bank-transfer-1' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.paymentVerification).toBe('none');

    const co2 = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    // A foreign pi_ (bound to another order) is still refused: ADR 0875 D3 holds.
    const foreign = `pi_foreign_${n++}`;
    intents.set(foreign, { amount: 2500, currency: 'usd', status: 'succeeded', metadata: { orderId: 'other', tenantId: 'other', orgId: 'other' } });
    const r = await owner.post<ErrBody>(c(orgId, `/orders/${encodeURIComponent(co2.body.orderId)}/pay`), { paymentIntentId: foreign });
    expect(r.status).toBe(409);
    expect(r.body.details?.code).toBe('payment_intent_mismatch');
  });

  it('a platform-lane order still refuses a manual id (ADR 0875 D3 / COM2UX-2)', async () => {
    const { owner, orgId, tenantId } = await shop();
    exempt(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.body.mode).toBe('live');
    const r = await owner.post<ErrBody>(c(orgId, `/orders/${encodeURIComponent(co.body.orderId)}/pay`), { paymentIntentId: 'manual:x' });
    expect(r.status).toBe(409);
    expect(r.body.details?.code).toBe('live_payment_required');
  });
});

describe('ADR 0877 D3 — refunds of a Connect charge reverse the transfer', () => {
  it('a full refund of a destination charge reverses the transfer AND returns the platform fee (Q5)', async () => {
    const { owner, orgId, tenantId } = await shop();
    const acct = await onboarded(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    const pi = `pi_cc_${n++}`;
    intents.set(pi, { amount: 2500, currency: 'usd', status: 'succeeded', metadata: { orderId: co.body.orderId, tenantId, orgId }, transfer_data: { destination: acct } });
    await markAsPaid(tenantId, orgId, co.body.orderId, pi, { actor: 'test', stripeKey: 'sk_test_mock' });
    const mark = calls.length;
    const r = await owner.post(c(orgId, `/orders/${encodeURIComponent(co.body.orderId)}/refund`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const refund = calls.slice(mark).find((x) => x.path === '/refunds');
    expect(refund?.form.get('reverse_transfer')).toBe('true');
    expect(refund?.form.get('refund_application_fee')).toBe('true');
  });

  it('a platform-lane refund does NOT reverse a transfer', async () => {
    const { owner, orgId, tenantId } = await shop();
    exempt(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    const pi = `pi_pl_${n++}`;
    intents.set(pi, { amount: 2500, currency: 'usd', status: 'succeeded', metadata: { orderId: co.body.orderId, tenantId, orgId } });
    await markAsPaid(tenantId, orgId, co.body.orderId, pi, { actor: 'test', stripeKey: 'sk_test_mock' });
    const mark = calls.length;
    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(co.body.orderId)}/refund`))).status).toBe(200);
    const platformRefund = calls.slice(mark).find((x) => x.path === '/refunds');
    expect(platformRefund?.form.get('reverse_transfer')).toBeNull();
    expect(platformRefund?.form.get('refund_application_fee')).toBeNull();
  });
});

describe('ADR 0877 D4 — a demo-era seller row re-onboards LIVE once the key resolves', () => {
  it('replaces the acct_demo_ row with a real Express account requesting both capabilities', async () => {
    const tenantId = `org:a0877-demo-${n++}`;
    const now = new Date().toISOString();
    await sellers.put({ tenantId, stripeAccountId: `acct_demo_${tenantId}`, onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true, region: 'US', capabilities: ['card_payments', 'transfers'], mode: 'demo', createdAt: now, updatedAt: now });
    await accountIndex.put({ stripeAccountId: `acct_demo_${tenantId}`, tenantId });
    const mark = calls.length;
    const out = await startOnboarding(tenantId, { refreshUrl: 'https://x.test/r', returnUrl: 'https://x.test/ret' });
    expect(out.mode).toBe('live');
    expect(out.seller.mode).toBe('live');
    expect(out.seller.stripeAccountId).toMatch(/^acct_live_/);
    const created = calls.slice(mark).find((x) => x.path === '/accounts');
    expect(created?.form.get('capabilities[card_payments][requested]')).toBe('true');
    expect(created?.form.get('capabilities[transfers][requested]')).toBe('true');
    expect(await accountIndex.get(`acct_demo_${tenantId}`)).toBeNull();
    expect((await accountIndex.get(out.seller.stripeAccountId))?.tenantId).toBe(tenantId);
  });
});

describe('ADR 0877 D6 — the owner sees which lane their store is on', () => {
  it('reports demo + connect_required for a non-operator tenant, connect for an onboarded one', async () => {
    const a = await shop();
    const ra = await a.owner.get(c(a.orgId, '/payments'));
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(ra.body).toMatchObject({ settlement: 'demo', reason: 'connect_required', connectAvailable: true });
    expect(JSON.stringify(ra.body)).not.toMatch(/sk_test/);
    const b = await shop();
    await onboarded(b.tenantId);
    expect((await b.owner.get(c(b.orgId, '/payments'))).body).toMatchObject({ settlement: 'connect' });
  });
});

describe('ADR 0877 grade fold-ins (CC2CD-3/-6/-15)', () => {
  it('quote accept for a Connect seller opens a destination charge and stamps the conversion order', async () => {
    const { owner, orgId, tenantId } = await shop();
    const acct = await onboarded(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'service', name: 'Retainer', price: 150, currency: 'USD' });
    const q = await owner.post<Created>(c(orgId, '/quotes'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    const qid: string = q.body.quoteId;
    expect((await owner.post(c(orgId, `/quotes/${encodeURIComponent(qid)}/send`))).status, 'send').toBeLessThan(300);
    const link = await owner.post<Created>(`/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'commerce_quote', resourceId: qid });
    expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
    const mark = calls.length;
    const acc = await client().post<Checkout>(pub(orgId, `/quotes/${encodeURIComponent(qid)}/accept`), { token: link.body.token });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.mode).toBe('live');
    const [session] = moneyCallsSince(mark);
    expect(session!.form.get('payment_intent_data[transfer_data][destination]')).toBe(acct);
    expect(session!.form.get('payment_intent_data[application_fee_amount]')).toBe('300');
    expect((await getOrder(tenantId, orgId, acc.body.orderId))?.settlement).toEqual({ kind: 'connect', destinationAccountId: acct });
  });

  it('a subscription-invoice order (in_) is refused typed before any Stripe call', async () => {
    const { owner, orgId, tenantId } = await shop();
    exempt(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const o = await owner.post<Created>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    await markAsPaid(tenantId, orgId, o.body.orderId, `in_test_${n++}`, { actor: 'test' });
    const mark = calls.length;
    const r = await owner.post<ErrBody>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/refund`));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.details?.code).toBe('refund_in_stripe');
    expect(calls.slice(mark).filter((x) => x.path === '/refunds' || x.path.startsWith('/payment_intents'))).toEqual([]);
  });

  it('a partial refund of a destination charge reverses the transfer too', async () => {
    const { owner, orgId, tenantId } = await shop();
    const acct = await onboarded(tenantId);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const co = await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    const pi = `pi_ccp_${n++}`;
    intents.set(pi, { amount: 2500, currency: 'usd', status: 'succeeded', metadata: { orderId: co.body.orderId, tenantId, orgId }, transfer_data: { destination: acct } });
    await markAsPaid(tenantId, orgId, co.body.orderId, pi, { actor: 'test', stripeKey: 'sk_test_mock' });
    const mark = calls.length;
    const r = await owner.post(c(orgId, `/orders/${encodeURIComponent(co.body.orderId)}/partial-refund`), { amount: 5, refundKey: `k-${n++}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const refund = calls.slice(mark).find((x) => x.path === '/refunds');
    expect(refund?.form.get('amount')).toBe('500');
    expect(refund?.form.get('reverse_transfer')).toBe('true');
    expect(refund?.form.get('refund_application_fee')).toBe('true'); // Stripe prorates it on a partial
  });

  it('an account event from a SUPERSEDED account never overwrites the current account', async () => {
    const { handleConnectEvent } = await import('../src/features/commerce-connect/webhookHandlers.js');
    const tenantId = `org:a0877-sup-${n++}`;
    const current = await onboarded(tenantId);
    await accountIndex.put({ stripeAccountId: 'acct_old_one', tenantId });
    await handleConnectEvent({ event: { id: `evt_${n++}`, type: 'account.application.deauthorized', account: 'acct_old_one', data: { object: {} } } });
    const s = await sellers.get(tenantId);
    expect(s?.stripeAccountId).toBe(current);
    expect(s?.onboardingState).toBe('enabled');
    expect(s?.chargesEnabled).toBe(true);
  });
});

describe('ADR 0877 Q1 — the storefront fee is its own config (0–15%, default 2%); the pack fee is unchanged', () => {
  it('defaults, clamps, per-tenant override, and leaves the marketplace fee alone', async () => {
    const t = `org:a0877-fee-${n++}`;
    expect(await getStorefrontFeePct(t)).toBe(2);
    expect(await getApplicationFeePct(t)).toBe(12);
    expect((await setStorefrontFeePct(t, 40)).applicationFeePct).toBe(15);
    expect((await setStorefrontFeePct(t, -3)).applicationFeePct).toBe(0);
    await setStorefrontFeePct(t, 5);
    expect(await getStorefrontFeePct(t)).toBe(5);
    expect(await getApplicationFeePct(t), 'the pack fee is a different config').toBe(12);
  });

  it('a per-tenant storefront override is what a Connect checkout charges', async () => {
    const { owner, orgId, tenantId } = await shop();
    await onboarded(tenantId);
    await setStorefrontFeePct(tenantId, 5);
    const p = await owner.post<Created>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 25, currency: 'USD' });
    const mark = calls.length;
    await client().post<Checkout & ErrBody>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(moneyCallsSince(mark)[0]!.form.get('payment_intent_data[application_fee_amount]')).toBe('125');
    expect((await owner.get(c(orgId, '/payments'))).body).toMatchObject({ settlement: 'connect', applicationFeePct: 5 });
  });
});
