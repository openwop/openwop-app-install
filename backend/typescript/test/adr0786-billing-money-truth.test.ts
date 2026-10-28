/**
 * ADR 0786 — billing money truth. Every leg that can go through the ONE public
 * webhook route does (`POST …/billing/webhook`, signed): tenant resolution lives in
 * the route, so a `processStripeEvent`-only test would not see D1's reachability
 * (the architect's finding #16, and the `subscription-bridge-integration` blind
 * spot). Payloads are REAL shapes — no `priceId` on a session, no `line_items`,
 * `customer: null` in payment mode, clover invoices under `parent`.
 *
 * A mock Stripe API (`OPENWOP_STRIPE_API_BASE`) answers the reads D1/D4/D7 make.
 *
 * Authority legs use the ADR 0554 §P3 harness (see adr0711-byok-operator-gate):
 * `sharedWorkspace: true`, membership in the workspace-root org, created BEFORE
 * login — otherwise the personal short-circuit makes every 403 unfalsifiable.
 *
 * Tracker: TST-BMT-1..12. Red when (sabotage-witnessed, wave 60): the checkout
 * row stops naming the tenant; a session can be credited twice; the paid check
 * reads the payload instead of Stripe; a metadata fallback is credited without
 * matching what Stripe sold; a row/metadata tenant mismatch is applied; a live
 * session loses its tenant metadata or a second customer is created; the event
 * lease never expires or never protects; the route answers 2xx for an in-flight
 * claim; a legacy processed row is reprocessed; a failed apply keeps its claim;
 * a displaced holder marks the event done; a non-entitled status grants a bundle;
 * an ended subscription resurrects; an unpaid event revokes a one-time grant; a
 * product subscription or its invoice touches the plan row; the clover `parent`
 * is ignored; a stale or incomplete subscription displaces the plan; the payload
 * beats the fetched state; `cancel_at_period_end` is dropped; the plan row loses
 * its CAS; the importer keeps `syncedAtMs`; a second plan is sold; a vanished or
 * unpaid plan is reconciled wrongly; a repriced pack credits the new price; a
 * dead customer is not replaced; only one `v1` is compared or a `v0` counts; the
 * prepaid draw ignores cached reads or the subset clamp; an anon session or an
 * editor may buy; the manage gate becomes a blanket denial.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setSubscriptionInvoiceHook, type SubscriptionInvoicePaid } from '../src/features/billing/subscriptionInvoiceHook.js';
import {
  __resetBilling, __seedEventClaim, __seedLegacyProcessedEvent, createCheckoutSession, getBalance, getSubscription, importBillingState,
  getBundleEntitlements, processStripeEvent, verifyStripeSignature,
} from '../src/features/billing/billingService.js';
import { prepaidDrawTokens } from '../src/providers/managedProvider.js';

const WEBHOOK_SECRET = 'whsec_adr0786';
const STRIPE_KEY = 'sk_test_adr0786';
const B = '/host/openwop-app/billing';

let server: http.Server;
let BASE = '';
let stripe: http.Server;

// ── mock Stripe ────────────────────────────────────────────────────────────────
const sessions = new Map<string, Record<string, unknown>>();
const subs = new Map<string, Record<string, unknown>>();
const posts: { path: string; body: string }[] = [];
let customerSeq = 0;
let sessionSeq = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro' });
  process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_pack: 100000, price_pack_big: 900000 });
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm' });

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST') posts.push({ path: url, body: raw });
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_${++customerSeq}` });
      if (req.method === 'POST' && url === '/v1/checkout/sessions' && new URLSearchParams(raw).get('customer') === 'cus_dead') {
        return send(400, { error: { message: 'No such customer: cus_dead', code: 'resource_missing', param: 'customer' } });
      }
      if (req.method === 'POST' && url === '/v1/checkout/sessions') { const id = `cs_live_${++sessionSeq}`; return send(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` }); }
      if (req.method === 'POST' && url === '/v1/billing_portal/sessions') return send(200, { url: 'https://billing.stripe.com/p/session/x' });
      const sm = /^\/v1\/checkout\/sessions\/([^?]+)/.exec(url);
      if (req.method === 'GET' && sm) { const s = sessions.get(decodeURIComponent(sm[1]!)); return s ? send(200, s) : send(404, { error: { message: 'No such checkout.session' } }); }
      const subm = /^\/v1\/subscriptions\/([^?]+)/.exec(url);
      if (req.method === 'GET' && subm) { const s = subs.get(decodeURIComponent(subm[1]!)); return s ? send(200, s) : send(404, { error: { message: 'No such subscription' } }); }
      return send(404, { error: { message: `unmocked ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('billing');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await setSecret('billing:webhook-secret', WEBHOOK_SECRET);
});

afterAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_BILLING_TOKEN_PACK_PRICES', 'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_STRIPE_API_BASE']) delete process.env[k];
  setSubscriptionInvoiceHook(null);
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => stripe.close(() => r()));
});

beforeEach(async () => {
  await __resetBilling();
  sessions.clear();
  subs.clear();
  posts.length = 0;
  customerSeq = 0;
});

const sign = (body: string, secret = WEBHOOK_SECRET): string => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};
async function deliver(event: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = JSON.stringify(event);
  const res = await fetch(`${BASE}${B}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, body: raw });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
/** The key is resolved per request by the route; tests toggle it on/off. */
async function withKey(on: boolean): Promise<void> { await setSecret('billing:stripe-key', on ? STRIPE_KEY : ''); }

describe('fixture honesty', () => {
  it('a signed delivery reaches the processor (202), an unsigned one is refused (401)', async () => {
    await withKey(false);
    const ok = await deliver({ id: 'evt_honest', type: 'customer.created', data: { object: { id: 'cus_z', metadata: { tenantId: 't-h' } } } });
    expect(ok.status).toBe(202);
    const raw = JSON.stringify({ id: 'evt_unsigned', type: 'x', data: {} });
    const bad = await fetch(`${BASE}${B}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: raw });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: 'unauthorized', message: 'Stripe signature verification failed.' });
  });
});

describe('D1 — a real token-pack purchase is credited exactly once', () => {
  it('a session with NO metadata (a pre-0786 in-flight shape) resolves through the checkout row', async () => {
    await withKey(false);
    const cs = await createCheckoutSession('t-pack', 'price_pack', null);
    const r = await deliver({ id: 'evt_p1', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, object: 'checkout.session', customer: null, payment_status: 'paid' } } });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('applied');
    expect((await getBalance('t-pack')).totalAvailable).toBe(100000);
  });

  it('`unpaid` on completed credits nothing; async_payment_succeeded credits; a third event for the session credits nothing', async () => {
    await withKey(true);
    const cs = await createCheckoutSession('t-ach', 'price_pack', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    sessions.set(cs.sessionId, { id: cs.sessionId, payment_status: 'unpaid', customer: 'cus_ach', metadata: {} });
    await deliver({ id: 'evt_a1', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'unpaid' } } });
    expect((await getBalance('t-ach')).totalAvailable).toBe(0);
    sessions.set(cs.sessionId, { id: cs.sessionId, payment_status: 'paid', customer: 'cus_ach', metadata: {} });
    await deliver({ id: 'evt_a2', type: 'checkout.session.async_payment_succeeded', data: { object: { id: cs.sessionId } } });
    expect((await getBalance('t-ach')).totalAvailable).toBe(100000);
    // A DIFFERENT event id for the SAME session (a manual resend, a replayed endpoint).
    await deliver({ id: 'evt_a3', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
    expect((await getBalance('t-ach')).totalAvailable).toBe(100000);
  });

  it('the paid check reads STRIPE, not the payload (a payload claiming `paid` for an unpaid session credits nothing)', async () => {
    await withKey(true);
    const cs = await createCheckoutSession('t-lie', 'price_pack', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    sessions.set(cs.sessionId, { id: cs.sessionId, payment_status: 'unpaid', metadata: {} });
    await deliver({ id: 'evt_lie', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
    expect((await getBalance('t-lie')).totalAvailable).toBe(0);
  });

  it('with no row, a metadata fallback must match what Stripe says was SOLD', async () => {
    await withKey(true);
    // Metadata claims the big pack; the session's line actually sold the small one.
    sessions.set('cs_orphan', { id: 'cs_orphan', payment_status: 'paid', metadata: { tenantId: 't-fb', kind: 'token-pack', priceId: 'price_pack_big' }, line_items: { data: [{ price: { id: 'price_pack' } }] } });
    await deliver({ id: 'evt_fb1', type: 'checkout.session.completed', data: { object: { id: 'cs_orphan', metadata: { tenantId: 't-fb', kind: 'token-pack', priceId: 'price_pack_big' } } } });
    expect((await getBalance('t-fb')).totalAvailable).toBe(0);
    sessions.set('cs_orphan2', { id: 'cs_orphan2', payment_status: 'paid', metadata: { tenantId: 't-fb', kind: 'token-pack', priceId: 'price_pack' }, line_items: { data: [{ price: { id: 'price_pack' } }] } });
    await deliver({ id: 'evt_fb2', type: 'checkout.session.completed', data: { object: { id: 'cs_orphan2', metadata: { tenantId: 't-fb', kind: 'token-pack', priceId: 'price_pack' } } } });
    expect((await getBalance('t-fb')).totalAvailable).toBe(100000);
  });

  it('a session that is not ours (no row, no `kind`) is ignored', async () => {
    await withKey(true);
    const r = await deliver({ id: 'evt_foreign', type: 'checkout.session.completed', data: { object: { id: 'cs_storefront', payment_status: 'paid', metadata: { tenantId: 't-foreign', orderId: 'o1' } } } });
    expect(r.body.status).toBe('ignored');
    expect((await getBalance('t-foreign')).totalAvailable).toBe(0);
  });

  it('a row whose tenant disagrees with the session metadata is refused', async () => {
    await withKey(false);
    const cs = await createCheckoutSession('t-row', 'price_pack', null);
    await processStripeEvent('t-row', { id: 'evt_mm', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid', metadata: { tenantId: 't-other' } } } });
    expect((await getBalance('t-row')).totalAvailable).toBe(0);
  });

  it('every live session carries {tenantId, kind, priceId} and the tenant\'s ONE customer (D1/D7)', async () => {
    await withKey(true);
    await createCheckoutSession('t-meta', 'price_pack', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    await createCheckoutSession('t-meta', 'price_crm', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    const creates = posts.filter((p) => p.path === '/v1/customers');
    expect(creates).toHaveLength(1); // the second checkout reuses the stored customer
    const checkouts = posts.filter((p) => p.path === '/v1/checkout/sessions').map((p) => new URLSearchParams(p.body));
    expect(checkouts).toHaveLength(2);
    for (const q of checkouts) {
      expect(q.get('customer')).toBe('cus_1');
      expect(q.get('metadata[tenantId]')).toBe('t-meta');
    }
    expect(checkouts[0]!.get('metadata[priceId]')).toBe('price_pack');
    expect(checkouts[1]!.get('metadata[priceId]')).toBe('price_crm');
    expect(checkouts[0]!.get('metadata[kind]')).toBe('token-pack');
    expect(checkouts[1]!.get('subscription_data[metadata][kind]')).toBe('bundle');
    expect((await getSubscription('t-meta')).stripeCustomerId).toBe('cus_1');
  });
});

describe('D0 — the event claim is a lease', () => {
  it('a delivery that died after claiming is taken over once the lease is stale', async () => {
    await withKey(false);
    const cs = await createCheckoutSession('t-crash', 'price_pack', null);
    await __seedEventClaim('evt_crash', Date.now() - 10 * 60_000);
    const r = await deliver({ id: 'evt_crash', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
    expect(r.body.status).toBe('applied');
    expect((await getBalance('t-crash')).totalAvailable).toBe(100000);
  });

  it('a FRESH claim answers 409 so Stripe retries (never a 2xx that would drop it)', async () => {
    await withKey(false);
    const cs = await createCheckoutSession('t-busy', 'price_pack', null);
    await __seedEventClaim('evt_busy', Date.now());
    const r = await deliver({ id: 'evt_busy', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
    expect(r.status).toBe(409);
    expect((await getBalance('t-busy')).totalAvailable).toBe(0);
  });
});

describe('D2 — a bundle is entitled only while its subscription is paid', () => {
  const bundleSub = (id: string, subId: string, status: string, type = 'customer.subscription.updated') => ({
    id, type, data: { object: { id: subId, status, metadata: { tenantId: 't-b', kind: 'bundle', bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } } },
  });
  it('`incomplete` (3-D Secure pending) and `unpaid` never grant; `active` does; `past_due` recovers', async () => {
    await withKey(false);
    await deliver(bundleSub('evt_b1', 'sub_b', 'incomplete', 'customer.subscription.created'));
    expect((await getBundleEntitlements('t-b')).bundles.crm?.status).toBe('canceled');
    await deliver(bundleSub('evt_b2', 'sub_b', 'active'));
    expect((await getBundleEntitlements('t-b')).bundles.crm?.status).toBe('active');
    await deliver(bundleSub('evt_b3', 'sub_b', 'past_due'));
    expect((await getBundleEntitlements('t-b')).bundles.crm).toMatchObject({ status: 'canceled', stripeStatus: 'past_due' });
    // A `past_due` grant is not terminal — paying recovers it (architect #7).
    await deliver(bundleSub('evt_b4', 'sub_b', 'active'));
    expect((await getBundleEntitlements('t-b')).bundles.crm?.status).toBe('active');
    await deliver(bundleSub('evt_b5', 'sub_b', 'unpaid'));
    expect((await getBundleEntitlements('t-b')).bundles.crm?.status).toBe('canceled');
  });
  it('a late `.updated(active)` after `.deleted` does not resurrect the grant', async () => {
    await withKey(false);
    await deliver(bundleSub('evt_bd1', 'sub_bd', 'active'));
    await deliver(bundleSub('evt_bd2', 'sub_bd', 'canceled', 'customer.subscription.deleted'));
    await deliver(bundleSub('evt_bd3', 'sub_bd', 'active'));
    expect((await getBundleEntitlements('t-b')).bundles.crm?.status).toBe('canceled');
  });
});

describe('D3 — only the plan subscription touches the plan row', () => {
  const planSub = (id: string, subId: string, status: string, type = 'customer.subscription.updated', extra: Record<string, unknown> = {}) => ({
    id, type, data: { object: { id: subId, customer: 'cus_merchant', status, metadata: { tenantId: 't-m' }, items: { data: [{ price: { id: 'price_pro' } }] }, ...extra } },
  });
  it('a commerce PRODUCT subscription stamped with the merchant\'s tenant leaves the merchant\'s plan alone', async () => {
    await withKey(false);
    await deliver(planSub('evt_m1', 'sub_plan', 'active'));
    // A shopper's product subscription: inline price, the MERCHANT's tenantId, the SHOPPER's customer.
    const product = (id: string, status: string, type = 'customer.subscription.updated') => ({
      id, type, data: { object: { id: 'sub_product', customer: 'cus_shopper', status, metadata: { tenantId: 't-m', productSubscriptionId: 'psub:1', orgId: 'o' }, items: { data: [{ price: { id: 'price_inline_1' } }] } } },
    });
    await deliver(product('evt_m2', 'active', 'customer.subscription.created'));
    await deliver(product('evt_m3', 'canceled', 'customer.subscription.deleted'));
    expect(await getSubscription('t-m')).toMatchObject({ status: 'active', planTier: 'pro', stripeCustomerId: 'cus_merchant', stripeSubscriptionId: 'sub_plan' });
  });

  it('a clover `invoice.paid` for a product subscription reaches the commerce hook, and not the plan\'s latest invoice', async () => {
    await withKey(false);
    await deliver(planSub('evt_mi0', 'sub_plan', 'active', 'customer.subscription.updated', { latest_invoice: 'in_plan' }));
    const fired: SubscriptionInvoicePaid[] = [];
    setSubscriptionInvoiceHook(async (e) => { fired.push(e); });
    // Clover: no top-level `subscription`, no top-level metadata; the shopper's customer.
    const r = await deliver({ id: 'evt_mi1', type: 'invoice.paid', data: { object: {
      id: 'in_product', customer: 'cus_shopper',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_product', metadata: { tenantId: 't-m', productSubscriptionId: 'psub:1' } } },
    } } });
    expect(r.body.status).toBe('applied');
    expect(fired).toEqual([{ tenantId: 't-m', stripeSubscriptionId: 'sub_product', invoiceId: 'in_product' }]);
    expect((await getSubscription('t-m')).latestInvoiceId).toBe('in_plan');
    setSubscriptionInvoiceHook(null);
  });
});

describe('D4 — order-independent plan state', () => {
  const ev = (id: string, subId: string, status: string, type = 'customer.subscription.updated') => ({
    id, type, data: { object: { id: subId, customer: 'cus_o', status, metadata: { tenantId: 't-o', kind: 'plan' }, items: { data: [{ price: { id: 'price_pro' } }] } } },
  });
  it('keyless: a late `.updated(active)` after `.deleted` stays canceled (terminal per id)', async () => {
    await withKey(false);
    await deliver(ev('evt_o1', 'sub_o', 'active'));
    await deliver(ev('evt_o2', 'sub_o', 'canceled', 'customer.subscription.deleted'));
    await deliver(ev('evt_o3', 'sub_o', 'active'));
    expect((await getSubscription('t-o')).status).toBe('canceled');
  });
  it('an old subscription\'s events never overwrite the current one; an unpaid new one waits', async () => {
    await withKey(false);
    await deliver(ev('evt_s1', 'sub_old', 'active'));
    await deliver(ev('evt_s2', 'sub_old', 'canceled', 'customer.subscription.deleted'));
    await deliver(ev('evt_s3', 'sub_new', 'incomplete', 'customer.subscription.created'));
    expect((await getSubscription('t-o')).stripeSubscriptionId).toBe('sub_old'); // incomplete does not displace
    await deliver(ev('evt_s4', 'sub_new', 'active'));
    expect(await getSubscription('t-o')).toMatchObject({ stripeSubscriptionId: 'sub_new', status: 'active' });
    await deliver(ev('evt_s5', 'sub_old', 'active')); // stale event for the ended subscription
    await deliver(ev('evt_s6', 'sub_old', 'past_due'));
    expect(await getSubscription('t-o')).toMatchObject({ stripeSubscriptionId: 'sub_new', status: 'active' });
  });
  it('`cancel_at_period_end` is carried so the page never promises a renewal that will not happen', async () => {
    await withKey(false);
    await deliver({ id: 'evt_capE', type: 'customer.subscription.updated', data: { object: { id: 'sub_cape', customer: 'cus_o', status: 'active', cancel_at_period_end: true, metadata: { tenantId: 't-cape', kind: 'plan' }, items: { data: [{ price: { id: 'price_pro' } }] } } } });
    expect((await getSubscription('t-cape')).cancelAtPeriodEnd).toBe(true);
  });
  it('with a key, the FETCHED state wins over a stale payload', async () => {
    await withKey(true);
    subs.set('sub_f', { id: 'sub_f', customer: 'cus_o', status: 'active', metadata: { tenantId: 't-o', kind: 'plan' }, items: { data: [{ price: { id: 'price_pro' } }] } });
    // The payload is an old `incomplete` snapshot delivered late.
    await deliver(ev('evt_f1', 'sub_f', 'incomplete'));
    expect((await getSubscription('t-o')).status).toBe('active');
  });
  it('D9: a subscription the key cannot read (404) is acked and ignored, not 500 forever', async () => {
    await withKey(true);
    const r = await deliver(ev('evt_404', 'sub_gone', 'active'));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('ignored');
  });
  it('a write holding a STALE row cannot clobber a newer one (CAS, deterministic interleave)', async () => {
    // The pre-0786 lost update, forced rather than hoped for: the invoice handler
    // reads the plan row, PAUSES, the subscription goes `active` meanwhile, then the
    // invoice handler writes. A get→put writes the stale `incomplete` back; the CAS
    // fails, re-reads and keeps `active`. (A Promise.all of deliveries was measured
    // VACUOUS here — memory storage never interleaves on its own.)
    await withKey(false);
    await processStripeEvent('t-cas', ev('evt_cas0', 'sub_cas', 'incomplete', 'customer.subscription.created'));
    const storage = __hostExtStorage()!;
    const origGet = storage.kvGet.bind(storage);
    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let paused!: () => void;
    const pausedP = new Promise<void>((r) => { paused = r; });
    storage.kvGet = async (key: string) => {
      const v = await origGet(key);
      if (armed && key === 'hostext:billing:subscription:t-cas') { armed = false; paused(); await gate; }
      return v;
    };
    try {
      const invoice = processStripeEvent('t-cas', { id: 'evt_cas_inv', type: 'invoice.created', data: { object: { id: 'in_cas', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_cas', metadata: {} } } } } });
      await pausedP; // the invoice handler now holds the `incomplete` row
      await processStripeEvent('t-cas', ev('evt_cas1', 'sub_cas', 'active'));
      expect((await getSubscription('t-cas')).status).toBe('active');
      release();
      await invoice;
    } finally {
      storage.kvGet = origGet;
    }
    expect(await getSubscription('t-cas')).toMatchObject({ status: 'active', latestInvoiceId: 'in_cas' });
  });
  it('the importer never sets `syncedAtMs` (only a fetched state may)', async () => {
    await importBillingState({ subscriptions: [{ tenantId: 't-imp', planTier: 'pro', status: 'active', syncedAtMs: 9e15, updatedAt: '2026-01-01T00:00:00.000Z' }] });
    expect((await getSubscription('t-imp')).syncedAtMs).toBeUndefined();
  });
});

describe('D7 — one live plan', () => {
  it('a second plan checkout is refused 409 while Stripe says the plan is live', async () => {
    await withKey(true);
    subs.set('sub_live', { id: 'sub_live', status: 'active' });
    await importBillingState({ subscriptions: [{ tenantId: 't-409', planTier: 'pro', status: 'active', stripeCustomerId: 'cus_409', stripeSubscriptionId: 'sub_live', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    await expect(createCheckoutSession('t-409', 'price_pro', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' })).rejects.toMatchObject({ httpStatus: 409 });
  });
  it('a row that says live but Stripe says gone is reconciled, not a lockout', async () => {
    await withKey(true);
    await importBillingState({ subscriptions: [{ tenantId: 't-stale', planTier: 'pro', status: 'active', stripeCustomerId: 'cus_stale', stripeSubscriptionId: 'sub_vanished', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    const cs = await createCheckoutSession('t-stale', 'price_pro', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    expect(cs.mode).toBe('live');
    expect((await getSubscription('t-stale')).status).toBe('canceled');
  });
});

describe('grade-code fixes (BILLCD-1/2/4/5/9)', () => {
  it('BILLCD-1: a recoverable (`unpaid`) plan is recorded, not ENDED, and the checkout is refused; paying later still applies', async () => {
    await withKey(true);
    subs.set('sub_unpaid', { id: 'sub_unpaid', customer: 'cus_u', status: 'unpaid', metadata: { tenantId: 't-unpaid', kind: 'plan' }, items: { data: [{ price: { id: 'price_pro' } }] } });
    await importBillingState({ subscriptions: [{ tenantId: 't-unpaid', planTier: 'pro', status: 'active', stripeCustomerId: 'cus_u', stripeSubscriptionId: 'sub_unpaid', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    await expect(createCheckoutSession('t-unpaid', 'price_pro', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' })).rejects.toMatchObject({ httpStatus: 409 });
    const row = await getSubscription('t-unpaid');
    expect(row.status).toBe('unpaid');
    expect(row.endedSubscriptionIds ?? []).not.toContain('sub_unpaid');
    // The customer pays the open invoice: Stripe moves it to active, and that must land.
    subs.set('sub_unpaid', { ...subs.get('sub_unpaid')!, status: 'active' });
    await deliver({ id: 'evt_unpaid_paid', type: 'customer.subscription.updated', data: { object: { id: 'sub_unpaid', status: 'active', metadata: { tenantId: 't-unpaid' } } } });
    expect((await getSubscription('t-unpaid')).status).toBe('active');
  });
  it('BILLCD-2: keyless, a recoverable plan row still refuses a second plan', async () => {
    await withKey(false);
    await importBillingState({ subscriptions: [{ tenantId: 't-paused', planTier: 'pro', status: 'paused', stripeSubscriptionId: 'sub_p', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    await expect(createCheckoutSession('t-paused', 'price_pro', null)).rejects.toMatchObject({ httpStatus: 409 });
  });
  it('BILLCD-4: a pack repriced after checkout still credits what was SOLD', async () => {
    await withKey(false);
    const cs = await createCheckoutSession('t-reprice', 'price_pack', null);
    const saved = process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES;
    process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_pack: 5 });
    try {
      await deliver({ id: 'evt_reprice', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
    } finally {
      process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = saved;
    }
    expect((await getBalance('t-reprice')).totalAvailable).toBe(100000);
  });
  it('BILLCD-5: a stored customer Stripe no longer knows is replaced, not a permanent 502', async () => {
    await withKey(true);
    await importBillingState({ subscriptions: [{ tenantId: 't-dead', planTier: 'free', status: 'none', stripeCustomerId: 'cus_dead', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    const cs = await createCheckoutSession('t-dead', 'price_pack', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    expect(cs.mode).toBe('live');
    expect((await getSubscription('t-dead')).stripeCustomerId).toBe('cus_1');
  });
  it('BILLCD-9: an unpaid subscription event never revokes a paid ONE-TIME grant', async () => {
    await withKey(false);
    const saved = process.env.OPENWOP_BILLING_BUNDLE_ONETIME;
    process.env.OPENWOP_BILLING_BUNDLE_ONETIME = JSON.stringify(['crm']);
    try {
      const cs = await createCheckoutSession('t-ot', 'price_crm', null);
      await deliver({ id: 'evt_ot_paid', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
    } finally {
      if (saved === undefined) delete process.env.OPENWOP_BILLING_BUNDLE_ONETIME; else process.env.OPENWOP_BILLING_BUNDLE_ONETIME = saved;
    }
    expect((await getBundleEntitlements('t-ot')).bundles.crm?.status).toBe('active');
    await deliver({ id: 'evt_ot_sub', type: 'customer.subscription.created', data: { object: { id: 'sub_ot', status: 'incomplete', metadata: { tenantId: 't-ot', bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } } } });
    expect((await getBundleEntitlements('t-ot')).bundles.crm?.status).toBe('active');
  });
  it('BILLCD-3: a failed apply RELEASES its claim — the retry is not told 409', async () => {
    await withKey(true);
    // The fetch fails TRANSIENTLY (the Stripe base points at a closed port → connection refused → 500).
    subs.set('sub_flaky', { id: 'sub_flaky', status: 'active', metadata: { tenantId: 't-rel', kind: 'plan' }, items: { data: [{ price: { id: 'price_pro' } }] } });
    await setSecret('billing:stripe-key', 'sk_rejected_key_that_mock_ignores');
    const origBase = process.env.OPENWOP_STRIPE_API_BASE;
    process.env.OPENWOP_STRIPE_API_BASE = 'http://127.0.0.1:1'; // connection refused → transient → 500
    try {
      const first = await deliver({ id: 'evt_rel', type: 'customer.subscription.updated', data: { object: { id: 'sub_flaky', status: 'active', metadata: { tenantId: 't-rel', kind: 'plan' } } } });
      expect(first.status).toBe(500);
    } finally {
      process.env.OPENWOP_STRIPE_API_BASE = origBase;
    }
    await withKey(true);
    const retry = await deliver({ id: 'evt_rel', type: 'customer.subscription.updated', data: { object: { id: 'sub_flaky', status: 'active', metadata: { tenantId: 't-rel', kind: 'plan' } } } });
    expect(retry.status).toBe(202);
    expect((await getSubscription('t-rel')).status).toBe('active');
  });
});

describe('the LIVE bundle tenant\'s renewal still applies (regression, prod shape)', () => {
  // Prod (2026-09-29, ce read-only sizing): ONE live bundle tenant (crm + marketing),
  // six processed webhooks — monthly renewals. Its subscriptions were created by the
  // PRE-0786 checkout: metadata {tenantId, bundleId}, no `kind`; its grant rows carry no
  // `stripeStatus`; its ledger rows carry no `state`. None of the new gates may reject it.
  const renewal = (id: string, subId: string, bundleId: string, periodEnd: number) => ({
    id, type: 'customer.subscription.updated',
    data: { object: { id: subId, customer: 'cus_live', status: 'active', metadata: { tenantId: 't-live', bundleId },
      items: { data: [{ price: { id: 'price_crm' }, current_period_end: periodEnd }] } } },
  });
  it('keyless: a pre-0786 grant renews `active`; an already-processed legacy event id is a 202 duplicate, never a 409', async () => {
    await withKey(false);
    await deliver(renewal('evt_live_jul', 'sub_live_crm', 'crm', 1_783_000_000));
    expect((await getBundleEntitlements('t-live')).bundles.crm?.status).toBe('active');
    await __seedLegacyProcessedEvent('evt_live_aug');
    const replayed = await deliver(renewal('evt_live_aug', 'sub_live_crm', 'crm', 1_785_600_000));
    expect(replayed.status).toBe(202);
    expect(replayed.body.status).toBe('duplicate');
    const sep = await deliver(renewal('evt_live_sep', 'sub_live_crm', 'crm', 1_788_300_000));
    expect(sep.status).toBe(202);
    expect((await getBundleEntitlements('t-live')).bundles.crm).toMatchObject({ status: 'active', stripeStatus: 'active', stripeSubscriptionId: 'sub_live_crm' });
    // The renewal's clover invoice resolves through `parent` and must not mint a plan.
    const inv = await deliver({ id: 'evt_live_inv', type: 'invoice.paid', data: { object: { id: 'in_live', customer: 'cus_live', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_live_crm', metadata: { tenantId: 't-live', bundleId: 'crm' } } } } } });
    expect(inv.status).toBe(202);
    const plan = await getSubscription('t-live');
    expect(plan.status).toBe('none');
    expect(plan.stripeCustomerId).toBe('cus_live'); // the portal can now open for a bundle-only tenant
  });
  it('with a key: the fetched `active` renewal applies', async () => {
    await withKey(true);
    subs.set('sub_live_mkt', { id: 'sub_live_mkt', customer: 'cus_live', status: 'active', metadata: { tenantId: 't-live', bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } });
    const r = await deliver(renewal('evt_live_key', 'sub_live_mkt', 'crm', 1_788_300_000));
    expect(r.body.status).toBe('applied');
    expect((await getBundleEntitlements('t-live')).bundles.crm?.status).toBe('active');
  });
});

describe('BILLCD-3 — finishing needs OWNERSHIP of the claim', () => {
  it('a holder whose claim was taken over mid-apply does not mark the event done', async () => {
    await withKey(false);
    const cs = await createCheckoutSession('t-own', 'price_pack', null);
    const storage = __hostExtStorage()!;
    const origGet = storage.kvGet.bind(storage);
    // Pause on the SECOND read of the checkout row: the first is the route's tenant
    // resolution (before the claim); the second is inside the apply, i.e. A already
    // holds the claim. (Pausing on the first read made B's claim pre-empt A entirely —
    // measured: A got 409 and nothing was credited.)
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let paused!: () => void;
    const pausedP = new Promise<void>((r) => { paused = r; });
    storage.kvGet = async (key: string) => {
      const v = await origGet(key);
      if (key === `hostext:billing:checkout:${cs.sessionId}` && ++reads === 2) { paused(); await gate; }
      return v;
    };
    try {
      const a = deliver({ id: 'evt_own', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } });
      await pausedP; // A holds the claim and is mid-apply
      // B took the claim over: a fresh claim that is NOT A's row (distinct claimedAt —
      // the same millisecond would serialize identically and let A's CAS pass).
      await __seedEventClaim('evt_own', Date.now() + 1_000);
      release();
      await a;
    } finally {
      storage.kvGet = origGet;
    }
    // A must NOT have marked B's in-flight claim `done`: a delivery now is still in progress.
    expect((await deliver({ id: 'evt_own', type: 'checkout.session.completed', data: { object: { id: cs.sessionId, payment_status: 'paid' } } })).status).toBe(409);
    expect((await getBalance('t-own')).totalAvailable).toBe(100000); // A's (idempotent) effect landed once
  });
});

describe('D8 — any matching v1 verifies (secret roll)', () => {
  it('accepts the right signature in either position; rejects when none match', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = '{"id":"evt_roll"}';
    const good = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
    const other = createHmac('sha256', 'whsec_new').update(`${t}.${body}`).digest('hex');
    for (const header of [`t=${t},v1=${good},v1=${other}`, `t=${t},v1=${other},v1=${good}`, `t=${t},v0=${other},v1=${good}`]) {
      expect(verifyStripeSignature({ signingSecret: WEBHOOK_SECRET, signatureHeader: header, rawBody: body, now }).ok, header).toBe(true);
    }
    expect(verifyStripeSignature({ signingSecret: WEBHOOK_SECRET, signatureHeader: `t=${t},v1=${other},v0=${good}`, rawBody: body, now })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('D6 — the prepaid draw discounts cached reads', () => {
  it('OpenAI-compatible (subset) and Anthropic (disjoint) arithmetic', () => {
    expect(prepaidDrawTokens('minimax', { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 800 }, 0.2)).toBe(200 + 160 + 100);
    expect(prepaidDrawTokens('anthropic', { inputTokens: 200, outputTokens: 100, cachedReadTokens: 800 }, 0.1)).toBe(200 + 80 + 100);
    // Cached can never exceed the prompt it is a subset of.
    expect(prepaidDrawTokens('minimax', { inputTokens: 100, outputTokens: 0, cachedReadTokens: 5000 }, 0.2)).toBe(20);
    expect(prepaidDrawTokens('minimax', { inputTokens: 100, outputTokens: 10 }, 0.2)).toBe(110);
  });
});

// ── D5 authority (route) ─────────────────────────────────────────────────────
describe('D5 — buying and the portal are admin acts; anon never buys', () => {
  const ADMIN = 'oidc:bill-admin';
  const EDITOR = 'oidc:bill-editor';
  let WS = '';
  async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
    const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
    });
    expect(res.status).toBeLessThan(300);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }
  const call = (path: string, cookie: string, method = 'POST', body: unknown = {}) => fetch(`${BASE}${path}`, {
    method, headers: { cookie, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const WRITES: ReadonlyArray<[string, string, unknown]> = [
    ['checkout', `${B}/checkout`, { priceId: 'price_pack' }],
    ['bundle checkout', `${B}/bundles/crm/checkout`, {}],
    ['portal', `${B}/portal`, {}],
  ];

  beforeAll(async () => {
    const ws = await createWorkspace({ name: 'ADR 0786 workspace', ownerSubject: 'oidc:bill-owner' });
    WS = ws.orgId ?? ws.tenantId;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  });

  it('fixture honesty: the editor IS a member (the ungated read answers 200)', async () => {
    await withKey(false);
    expect((await call(`${B}/subscription`, await login(EDITOR, WS), 'GET')).status).toBe(200);
  });
  for (const [name, path, body] of WRITES) {
    it(`an EDITOR is refused ${name} with a 403 naming host:billing:manage`, async () => {
      await withKey(false);
      const res = await call(path, await login(EDITOR, WS), 'POST', body);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('host:billing:manage');
    });
  }
  it('an ADMIN is admitted to every write (the gate is not a blanket denial)', async () => {
    await withKey(false);
    const admin = await login(ADMIN, WS);
    // Keyless: each write answers its own success, never a refusal or an error.
    const expected: Record<string, number> = { checkout: 201, 'bundle checkout': 201, portal: 200 };
    for (const [name, path, body] of WRITES) {
      const res = await call(path, admin, 'POST', body);
      expect(res.status, `${name}: ${await res.clone().text()}`).toBe(expected[name]);
    }
  });
  it('a solo user in their own personal workspace is admitted (the short-circuit)', async () => {
    await withKey(false);
    const res = await call(`${B}/checkout`, await login('oidc:bill-solo', 'user:bill-solo', false), 'POST', { priceId: 'price_pack' });
    expect(res.status).toBe(201);
  });
  it('an ANON session is refused on every write, although the personal short-circuit would admit it', async () => {
    await withKey(false);
    const anon = await login('oidc:bill-anon', 'anon:sid-786', false);
    for (const [name, path, body] of WRITES) {
      const res = await call(path, anon, 'POST', body);
      expect(res.status, `${name} admitted an anon session`).toBe(403);
      expect(await res.text()).toContain('anonymous_session');
    }
  });
});
