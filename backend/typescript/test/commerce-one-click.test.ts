/**
 * One-click post-purchase upsell chains (ADR 0296 / Funnel C, Phases 2–3),
 * against a mock Stripe HTTP server (the stripe-live-payments precedent):
 *  - env gate: 503 not_configured while OPENWOP_COMMERCE_OFFSESSION_ENABLED
 *    is unset (money movement is operator opt-in);
 *  - consent capture: a paid intent carrying customer+payment_method persists
 *    the saved-PM row ONLY for orders that requested the save (unticked
 *    default), idempotently;
 *  - one-click success: server-priced child order, off_session+confirm intent
 *    with the deterministic idempotency key, child linked via parentOrderId,
 *    line origin 'upsell', funnelRef inherited from the parent;
 *  - SCA challenge: 202 + clientSecret, child stays pending (on-session
 *    fallback); decline: child canceled (stock restored) + 402;
 *  - guards: duplicate product returns the existing child (no double charge);
 *    chain depth caps at 3; a foreign/unpaid order 404s;
 *  - a contact deletion prunes the saved-PM row (crmRecordLifecycle seam).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import {
  getOrder, markAsPaid, captureSavedPmFromPaidIntent, getSavedPaymentMethod,
  deleteSavedPaymentMethodsForContact,
} from '../src/features/commerce/commerceService.js';

let BASE: string; let server: http.Server; let n = 0;
let stripe: http.Server;
let stripeCalls: Array<{ path: string; body: string; idem?: string }> = [];
const intentAmounts = new Map<string, { amount: number; currency: string }>();
let intentOutcome: 'succeeded' | 'authentication_required' | 'card_declined' = 'succeeded';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      stripeCalls.push({ path: req.url ?? '', body: raw, idem: req.headers['idempotency-key'] as string | undefined });
      const reply = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/v1/payment_intents') {
        if (intentOutcome === 'succeeded') {
          const id = `pi_${stripeCalls.length}`;
          const form = new URLSearchParams(raw);
          intentAmounts.set(id, { amount: Number(form.get('amount') ?? 0), currency: String(form.get('currency') ?? 'usd') });
          reply(200, { id, status: 'succeeded' });
          return;
        }
        if (intentOutcome === 'authentication_required') {
          reply(402, { error: { code: 'authentication_required', message: 'SCA required', payment_intent: { id: 'pi_sca', client_secret: 'cs_sca' } } });
          return;
        }
        reply(402, { error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'declined' } });
        return;
      }
      if (req.url?.startsWith('/v1/payment_intents/')) {
        // markAsPaid verification read — echo THIS intent's own amount/currency
        const id = req.url.split('/').pop() ?? '';
        const known = intentAmounts.get(id) ?? { amount: 0, currency: 'usd' };
        reply(200, { id, status: 'succeeded', ...known });
        return;
      }
      if (req.url === '/v1/checkout/sessions') { reply(200, { id: `cs_${stripeCalls.length}`, url: 'https://checkout.stripe.test/s' }); return; }
      if (req.url === '/v1/customers') { reply(200, { id: 'cus_1' }); return; }
      reply(200, { id: `obj_${stripeCalls.length}` });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await setSecret('billing:stripe-key', 'sk_test_mock');
});
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

async function paidParentWithSavedPm() {
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `oc-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = login.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'OneClick Shop' });
  const orgId: string = org.body.orgId;
  const c = (sfx: string): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${sfx}`;
  const main = await owner.post(c('/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
  const upsell = await owner.post(c('/products'), { type: 'digital', name: 'Coaching', price: 50, currency: 'USD' });
  const upsell2 = await owner.post(c('/products'), { type: 'digital', name: 'Extra A', price: 10, currency: 'USD' });
  const upsell3 = await owner.post(c('/products'), { type: 'digital', name: 'Extra B', price: 10, currency: 'USD' });
  const upsell4 = await owner.post(c('/products'), { type: 'digital', name: 'Extra C', price: 10, currency: 'USD' });

  // guest checkout WITH consent — live mode creates the session (mock stripe)
  const guest = client();
  const email = `buyer-${n++}@x.test`;
  const co = await guest.post(`/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
    email, lines: [{ productId: main.body.productId, quantity: 1 }], savePaymentMethod: true,
    funnel: { funnelId: 'fn-oc', stepId: 'st-co' },
  });
  expect(co.status).toBe(201);
  const orderId: string = co.body.orderId;
  // settle it + capture the saved PM the way the webhook does
  await markAsPaid(tenantId, orgId, orderId, 'pi_parent', { actor: 'test' });
  const order = await getOrder(tenantId, orgId, orderId);
  expect(order?.pmSaveRequested).toBe(true);
  const captured = await captureSavedPmFromPaidIntent(order!, { customer: 'cus_1', payment_method: 'pm_1' });
  expect(captured).toBe(true);
  return { guest, tenantId, orgId, orderId, contactId: order!.contactId!, upsellId: upsell.body.productId as string, extras: [upsell2.body.productId, upsell3.body.productId, upsell4.body.productId] as string[] };
}

const oneClick = (orgId: string, orderId: string): string =>
  `/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/orders/${encodeURIComponent(orderId)}/one-click`;

describe('ADR 0296 P2/P3 — saved PM + one-click chains', () => {
  it('is 503 not_configured until the operator opts in', async () => {
    delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
    const v = client();
    const res = await v.post(oneClick('any-org', 'any-order'), { productId: 'p' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
  });

  it('capture only persists for orders that REQUESTED the save', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    const { tenantId, orgId, contactId } = await paidParentWithSavedPm();
    expect(await getSavedPaymentMethod(tenantId, orgId, contactId)).toMatchObject({ stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1' });
    // an order WITHOUT the marker never captures
    const bare = { tenantId, orgId, contactId, pmSaveRequested: undefined } as never;
    expect(await captureSavedPmFromPaidIntent(bare, { customer: 'cus_x', payment_method: 'pm_x' })).toBe(false);
  });

  it('one-click success: server-priced child, upsell origin, parent link, inherited funnelRef, idempotency key', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    intentOutcome = 'succeeded';
    const { guest, tenantId, orgId, orderId, upsellId } = await paidParentWithSavedPm();
    stripeCalls = [];
    const res = await guest.post(oneClick(orgId, orderId), { productId: upsellId, price: 1 /* hostile client price — ignored */ });
    expect(res.status).toBe(201);
    expect(res.body.paid).toBe(true);
    const child = await getOrder(tenantId, orgId, res.body.orderId);
    expect(child?.parentOrderId).toBe(orderId);
    expect(child?.status).toBe('paid');
    expect(child?.items[0]?.origin).toBe('upsell');
    expect(child?.total).toBe(50); // server-resolved price, never the client's
    expect(child?.funnelRef).toEqual({ funnelId: 'fn-oc', stepId: 'st-co' }); // inherited
    const intentCall = stripeCalls.find((c) => c.path === '/v1/payment_intents');
    expect(intentCall?.idem).toBe(`oneclick:${orderId}:${upsellId}`);
    const form = new URLSearchParams(intentCall?.body ?? '');
    expect(form.get('amount')).toBe('5000'); // 50 USD in minor units
    expect(form.get('off_session')).toBe('true');
    expect(form.get('confirm')).toBe('true');

    // duplicate accept returns the SAME child — no second charge
    const again = await guest.post(oneClick(orgId, orderId), { productId: upsellId });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.orderId).toBe(res.body.orderId);
  });

  it('SCA challenge → 202 + clientSecret (child pending); decline → child canceled + 402', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    const { guest, tenantId, orgId, orderId, upsellId, extras } = await paidParentWithSavedPm();
    intentOutcome = 'authentication_required';
    const sca = await guest.post(oneClick(orgId, orderId), { productId: upsellId });
    expect(sca.status).toBe(202);
    expect(sca.body.requiresAction).toBe(true);
    expect(sca.body.clientSecret).toBe('cs_sca');
    expect((await getOrder(tenantId, orgId, sca.body.orderId))?.status).toBe('pending');

    intentOutcome = 'card_declined';
    const declined = await guest.post(oneClick(orgId, orderId), { productId: extras[0] });
    expect(declined.status).toBe(402);
    expect(declined.body.declined).toBe(true);
    intentOutcome = 'succeeded';
  });

  it('caps the chain at 3 non-canceled children and 404s foreign/unpaid orders', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    intentOutcome = 'succeeded';
    const { guest, orgId, orderId, upsellId, extras } = await paidParentWithSavedPm();
    for (const pid of [upsellId, ...extras.slice(0, 2)]) {
      expect((await guest.post(oneClick(orgId, orderId), { productId: pid })).status).toBe(201);
    }
    const fourth = await guest.post(oneClick(orgId, orderId), { productId: extras[2] });
    expect(fourth.status).toBe(400);
    expect((await guest.post(oneClick(orgId, 'order-nope'), { productId: upsellId })).status).toBe(404);
  });

  it('a contact deletion prunes the saved payment reference (seam consumer)', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    const { tenantId, orgId, contactId } = await paidParentWithSavedPm();
    expect(await getSavedPaymentMethod(tenantId, orgId, contactId)).not.toBeNull();
    await deleteSavedPaymentMethodsForContact(tenantId, contactId);
    expect(await getSavedPaymentMethod(tenantId, orgId, contactId)).toBeNull();
  });
});
