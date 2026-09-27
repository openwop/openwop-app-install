/**
 * Commerce Connect — CC-4 (grade-pass open gap): the LIVE money paths, against a
 * mock Stripe server (the `stripe-live-payments` harness precedent) + real BYOK
 * secrets (`setSecret`, the `commerce-one-click` precedent).
 *
 *  - live onboarding: POST /v1/accounts (type=express) + account link
 *  - live createCheckout: the destination-charge session carries
 *    application_fee_amount + transfer_data[destination] + on_behalf_of +
 *    ccOrderId metadata on BOTH session and intent, with the deterministic
 *    Idempotency-Key = orderId
 *  - the platform↔seller region guard refuses a cross-region native purchase
 *  - the DUAL-SECRET webhook HTTP path: a Connect-secret-signed account event is
 *    routed to the handler; a platform-signed ccOrderId purchase event fulfils
 *    the order end-to-end over HTTP; a foreign signature is 401 fail-closed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { setSecret, removeSecret } from '../src/byok/secretResolver.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import {
  __resetCommerceConnect, startOnboarding, getSeller, upsertPaidListing, setListingApproval,
  createCheckout, getOrder, orderIdFor,
} from '../src/features/commerce-connect/connectService.js';

let BASE: string;
let appServer: http.Server;
let stripe: http.Server;
let stripeCalls: Array<{ method?: string; path?: string; body?: string; idempotencyKey?: string | string[] }> = [];
let respond: (req: { method?: string; path: string }) => { status: number; body: Record<string, unknown> };

const PLATFORM_SECRET = 'whsec_platform_test';
const CONNECT_SECRET = 'whsec_connect_test';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // MKT-UX-2 — the return-URL case drives the ROUTE (that is where the URLs are
  // built), so it needs a real signed-in caller: an anon session is now refused
  // by the GEN-CC-1 fold guard, which is correct and unrelated.
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { appServer = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`; res(); }); });
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      stripeCalls.push({ method: req.method, path: req.url ?? '', body: raw, idempotencyKey: req.headers['idempotency-key'] });
      const out = respond({ method: req.method, path: req.url ?? '' });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  await setSecret('billing:stripe-key', 'sk_test_cc');
  await setSecret('billing:webhook-secret', PLATFORM_SECRET);
  await setSecret('billing:connect-webhook-secret', CONNECT_SECRET);
});
afterAll(async () => {
  delete process.env.OPENWOP_STRIPE_API_BASE;
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await removeSecret('billing:stripe-key').catch(() => undefined);
  await removeSecret('billing:webhook-secret').catch(() => undefined);
  await removeSecret('billing:connect-webhook-secret').catch(() => undefined);
  await new Promise<void>((r) => stripe.close(() => r()));
  await new Promise<void>((res) => appServer.close(() => res()));
});

const URLS = { successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/no' };

/** Mock-Stripe live onboarding for one seller tenant (US unless overridden). */
async function liveSeller(tenantId: string, country = 'US'): Promise<string> {
  respond = ({ path }) => {
    if (path === '/v1/accounts') return { status: 200, body: { id: `acct_${tenantId}`, country } };
    if (path === '/v1/account_links') return { status: 200, body: { url: 'https://connect.stripe.com/setup/x' } };
    if (path?.startsWith('/v1/accounts/')) return { status: 200, body: { id: `acct_${tenantId}`, charges_enabled: true, payouts_enabled: true, details_submitted: true, country, capabilities: { card_payments: 'active', transfers: 'active' } } };
    return { status: 404, body: {} };
  };
  await startOnboarding(tenantId, { refreshUrl: URLS.cancelUrl, returnUrl: URLS.successUrl });
  const { syncSellerFromStripe } = await import('../src/features/commerce-connect/connectService.js');
  await syncSellerFromStripe(tenantId);
  const seller = (await getSeller(tenantId))!;
  expect(seller.mode).toBe('live');
  expect(seller.onboardingState).toBe('enabled');
  return seller.stripeAccountId;
}

const sign = (secret: string, body: string): string => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};
async function deliverWebhook(secret: string, event: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const body = JSON.stringify(event);
  const res = await fetch(`${BASE}/v1/host/openwop-app/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(secret, body) },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

describe('CC-4a — live onboarding + destination-charge checkout (mock Stripe)', () => {
  it('builds the destination charge exactly: fee + transfer_data + on_behalf_of + ccOrderId + deterministic idempotency', async () => {
    await __resetCommerceConnect();
    const acct = await liveSeller('lv-seller');
    await upsertPaidListing('lv-seller', { packName: 'p.live', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('p.live', 'approved');

    respond = ({ path }) => path === '/v1/checkout/sessions'
      ? { status: 200, body: { id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' } }
      : { status: 404, body: {} };
    stripeCalls = [];
    const started = await createCheckout('lv-buyer', 'p.live', URLS);

    expect(started.mode).toBe('live');
    expect(started.url).toBe('https://checkout.stripe.com/c/pay/cs_live_1');
    const orderId = orderIdFor('lv-buyer', 'p.live');
    expect(started.order.orderId).toBe(orderId);

    const call = stripeCalls.find((c) => c.path === '/v1/checkout/sessions')!;
    expect(call.idempotencyKey).toBe(orderId); // deterministic — a replay dedupes at Stripe
    const form = new URLSearchParams(call.body);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('4000');
    expect(form.get('payment_intent_data[application_fee_amount]')).toBe('480'); // 12% of $40, minor units
    expect(form.get('payment_intent_data[transfer_data][destination]')).toBe(acct);
    expect(form.get('payment_intent_data[on_behalf_of]')).toBe(acct);
    expect(form.get('metadata[ccOrderId]')).toBe(orderId);
    expect(form.get('payment_intent_data[metadata][ccOrderId]')).toBe(orderId); // rides the intent too
    expect((await getOrder(orderId))!.stripeSessionId).toBe('cs_live_1');
  });

  it('refuses a cross-region native purchase (platform↔seller guard)', async () => {
    await __resetCommerceConnect();
    await liveSeller('lv-de', 'DE'); // platform region defaults to US
    await upsertPaidListing('lv-de', { packName: 'p.de', lane: 'native-paid', priceMajorUnits: 10, currency: 'eur' });
    await setListingApproval('p.de', 'approved');
    await expect(createCheckout('lv-buyer', 'p.de', URLS)).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe('CC-4b — dual-secret webhook HTTP path (end-to-end)', () => {
  it('a CONNECT-secret-signed account event reaches the handler; a foreign signature is 401', async () => {
    await __resetCommerceConnect();
    const acct = await liveSeller('wh-seller');

    const evt = { id: 'evt_ws_1', type: 'account.updated', account: acct, data: { object: { id: acct, charges_enabled: false, payouts_enabled: true, country: 'US', capabilities: {}, requirements: { disabled_reason: 'requirements.past_due' } } } };
    const ok = await deliverWebhook(CONNECT_SECRET, evt);
    expect(ok.status).toBe(202);
    expect(ok.body.applied).toBe(true);
    expect((await getSeller('wh-seller'))!.onboardingState).toBe('restricted'); // the event actually applied

    const bad = await deliverWebhook('whsec_wrong', { ...evt, id: 'evt_ws_2' });
    expect(bad.status).toBe(401); // fail-closed when neither secret matches
  });

  it('a PLATFORM-signed ccOrderId purchase event fulfils the order over HTTP (no CAS stranding)', async () => {
    await __resetCommerceConnect();
    await liveSeller('wh-s2');
    await upsertPaidListing('wh-s2', { packName: 'p.wh', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('p.wh', 'approved');
    respond = ({ path }) => path === '/v1/checkout/sessions'
      ? { status: 200, body: { id: 'cs_wh', url: 'https://checkout.stripe.com/c/pay/cs_wh' } }
      : { status: 404, body: {} };
    const { order } = await createCheckout('wh-buyer', 'p.wh', URLS);

    const done = await deliverWebhook(PLATFORM_SECRET, {
      id: 'evt_wh_pay', type: 'checkout.session.completed',
      data: { object: { id: 'cs_wh', payment_status: 'paid', amount_total: 4000, currency: 'usd', payment_intent: 'pi_wh', metadata: { ccOrderId: order.orderId } } },
    });
    expect(done.status).toBe(202);
    expect(done.body.applied).toBe(true);
    expect((await getOrder(order.orderId))!.status).toBe('paid');
  });
});

describe('MKT-UX-2 — the Stripe return URLs point at the page the buyer started from', () => {
  /**
   * `successUrl` was `${base}/commerce-connect?purchase=success` — the SELLER-
   * ONBOARDING page — so a paying buyer, who is typically not a seller, landed
   * on "Become a seller … Start selling" immediately after a completed charge,
   * with no amount, no pack, no order id and no fulfilment expectation. The SPA
   * read nothing from `?purchase` at all.
   *
   * This asserts the URLs on the ACTUAL Stripe form rather than on the route
   * source, because the form is what Stripe redirects to. The order id must be
   * the deterministic `orderIdFor` value — the same id that is the CAS key and
   * the Idempotency-Key — so the return page fetches the real order instead of
   * guessing, and no new identifier enters the system.
   */
  it('success and cancel both land on /marketplace, carrying the deterministic order id', async () => {
    await __resetCommerceConnect();
    await liveSeller('ru-s');
    await upsertPaidListing('ru-s', { packName: 'p.ru', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('p.ru', 'approved');
    respond = ({ path }) => path === '/v1/checkout/sessions'
      ? { status: 200, body: { id: 'cs_ru', url: 'https://checkout.stripe.com/c/pay/cs_ru' } }
      : { status: 404, body: {} };
    stripeCalls = [];

    // Through the ROUTE, not the service — the route is where the URLs are built.
    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ru-buyer@e2e.test' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await fetch(`${BASE}/v1/host/openwop-app/commerce-connect/purchase/checkout`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ packName: 'p.ru' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { order } = (await res.json()) as { order: { orderId: string } };

    const form = new URLSearchParams(stripeCalls.find((c) => c.path === '/v1/checkout/sessions')!.body);
    for (const [key, outcome] of [['success_url', 'success'], ['cancel_url', 'cancelled']] as const) {
      const url = new URL(form.get(key)!);
      expect(url.pathname, `${key} must return the BUYER to the browse page, not seller onboarding`).toBe('/marketplace');
      expect(url.searchParams.get('purchase')).toBe(outcome);
      expect(url.searchParams.get('order'), 'the receipt needs the order id').toBe(order.orderId);
      expect(url.searchParams.get('pack')).toBe('p.ru');
    }
    // The id is DERIVED, never minted: the SAME value the CAS and Stripe's
    // Idempotency-Key use, recomputed here from the row's own buyer tenant.
    const read = await fetch(`${BASE}/v1/host/openwop-app/commerce-connect/orders/${order.orderId}`, { headers: { cookie } });
    const stored = (await read.json()) as { order: { buyerTenantId: string } };
    expect(order.orderId).toBe(orderIdFor(stored.order.buyerTenantId, 'p.ru'));
  });
});

describe('MPL-4 — the LIVE refund lane: the request is stamped, and the response says INITIATED', () => {
  /**
   * The lane that actually strands. `refundOrder` returned 200 with the order
   * still `paid` and NOTHING recording that a refund had been issued, so a lost
   * or mis-signed `charge.refunded` left the order `paid` forever, indistinguishable
   * from an order nobody ever refunded. The demo lane could not witness this — it
   * flips immediately — so this case has to exist here, against mock Stripe.
   */
  it('stamps refundRequestedAt + refundId while the status stays paid, and reports applied:false', async () => {
    await __resetCommerceConnect();
    await liveSeller('rf-s');
    await upsertPaidListing('rf-s', { packName: 'p.rf', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('p.rf', 'approved');
    respond = ({ path }) => path === '/v1/checkout/sessions'
      ? { status: 200, body: { id: 'cs_rf', url: 'https://checkout.stripe.com/c/pay/cs_rf' } }
      : { status: 404, body: {} };
    const { order } = await createCheckout('rf-buyer', 'p.rf', URLS);
    await deliverWebhook(PLATFORM_SECRET, {
      id: 'evt_rf_pay', type: 'checkout.session.completed',
      data: { object: { id: 'cs_rf', payment_status: 'paid', amount_total: 4000, currency: 'usd', payment_intent: 'pi_rf', metadata: { ccOrderId: order.orderId } } },
    });

    respond = ({ path }) => path === '/v1/refunds'
      ? { status: 200, body: { id: 're_live_1', status: 'succeeded' } }
      : { status: 404, body: {} };
    const { refundOrder } = await import('../src/features/commerce-connect/connectService.js');
    const out = await refundOrder(order.orderId);

    // The response is HONEST about which of the two things happened.
    expect(out.applied, 'the live lane INITIATES a refund; the flip rides charge.refunded').toBe(false);
    expect(out.state).toBe('initiated');
    expect(out.refundId).toBe('re_live_1');

    const stored = (await getOrder(order.orderId))!;
    expect(stored.status, 'the CAS-before-effect discipline is unchanged').toBe('paid');
    expect(stored.refundId, 'the refund must be RECORDED, not merely returned').toBe('re_live_1');
    expect(stored.refundRequestedAt, 'without this stamp the divergence is invisible').toBeTruthy();
  });

  it('a Stripe failure records NO refund stamp (a stamp for a refund that never happened is worse than none)', async () => {
    await __resetCommerceConnect();
    await liveSeller('rf-s2');
    await upsertPaidListing('rf-s2', { packName: 'p.rf2', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('p.rf2', 'approved');
    respond = ({ path }) => path === '/v1/checkout/sessions'
      ? { status: 200, body: { id: 'cs_rf2', url: 'https://checkout.stripe.com/c/pay/cs_rf2' } }
      : { status: 404, body: {} };
    const { order } = await createCheckout('rf-buyer2', 'p.rf2', URLS);
    await deliverWebhook(PLATFORM_SECRET, {
      id: 'evt_rf2_pay', type: 'checkout.session.completed',
      data: { object: { id: 'cs_rf2', payment_status: 'paid', amount_total: 4000, currency: 'usd', payment_intent: 'pi_rf2', metadata: { ccOrderId: order.orderId } } },
    });

    respond = () => ({ status: 402, body: { error: { message: 'charge already refunded' } } });
    const { refundOrder } = await import('../src/features/commerce-connect/connectService.js');
    await expect(refundOrder(order.orderId)).rejects.toBeTruthy();
    const stored = (await getOrder(order.orderId))!;
    expect(stored.refundRequestedAt).toBeUndefined();
    expect(stored.refundId).toBeUndefined();
  });
});
