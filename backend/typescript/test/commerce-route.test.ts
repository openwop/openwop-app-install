/**
 * E-Commerce (ADR 0177) — ROUTE harness: toggle gating, product CRUD, order create +
 * the lifecycle state machine (pay→inventory decrement, refund→restore, cancel guard,
 * fulfillment→delivered flips to fulfilled), RBAC, IDOR, CRM contactId validation.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
let n = 0;
const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function ownerWithMember(role: string): Promise<{ owner: ReturnType<typeof client>; member: ReturnType<typeof client>; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client(); await owner.post('/v1/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client(); const mr = await member.post('/v1/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' }); const orgId = org.body.orgId;
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: mr.body.user.userId, roles: [role] });
  return { owner, member, orgId };
}
const c = (orgId: string, suffix = '') => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('commerce — toggle gating', () => {
  it('404s when off', async () => {
    await enable('commerce', 'off');
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(c(orgId, '/products'))).status).toBe(404);
    await enable('commerce', 'on');
  });
});

describe('commerce — product CRUD + order lifecycle', () => {
  it('creates a physical product, orders it, pays (inventory decrements), refunds (restores)', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Widget', price: 25, currency: 'USD', inventory: 10 });
    expect(prod.status, JSON.stringify(prod.body)).toBe(201);
    const productId = prod.body.productId;

    const order = await owner.post(c(orgId, '/orders'), { lines: [{ productId, quantity: 3 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.subtotal).toBe(75);
    expect(order.body.status).toBe('pending');
    const orderId = order.body.orderId;

    const paid = await owner.post(c(orgId, `/orders/${orderId}/pay`), { paymentIntentId: 'pi_ext_123' });
    expect(paid.body.status).toBe('paid');
    expect(paid.body.paymentIntentId).toBe('pi_ext_123');
    expect((await owner.get(c(orgId, `/products/${productId}`))).body.inventory).toBe(7); // decremented

    const refunded = await owner.post(c(orgId, `/orders/${orderId}/refund`), {});
    expect(refunded.body.status).toBe('refunded');
    expect((await owner.get(c(orgId, `/products/${productId}`))).body.inventory).toBe(10); // restored
  });

  it('fulfillment → delivered flips the order to fulfilled; lifecycle guards hold', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Ebook', price: 9 });
    const order = await owner.post(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }] });
    const orderId = order.body.orderId;
    // cannot fulfill a pending (unpaid) order
    expect((await owner.post(c(orgId, `/orders/${orderId}/fulfillment`), { fulfillmentStatus: 'shipped' })).status).toBe(409);
    await owner.post(c(orgId, `/orders/${orderId}/pay`), { paymentIntentId: 'pi_x' });
    const delivered = await owner.post(c(orgId, `/orders/${orderId}/fulfillment`), { fulfillmentStatus: 'delivered' });
    expect(delivered.body.fulfillmentStatus).toBe('delivered');
    expect(delivered.body.status).toBe('fulfilled');
    // cannot cancel a fulfilled order (only pending)
    expect((await owner.post(c(orgId, `/orders/${orderId}/cancel`), {})).status).toBe(409);
  });

  it('rejects a foreign contactId + an order with an unknown product', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    expect((await owner.post(c(orgId, '/orders'), { contactId: 'contact:nope', lines: [] })).status).toBe(400);
    expect((await owner.post(c(orgId, '/orders'), { lines: [{ productId: 'prod:nope', quantity: 1 }] })).status).toBe(400);
  });
});

describe('commerce — coupons + public storefront (Phases 2-3)', () => {
  it('applies a coupon (discount + total) and rejects an invalid code', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post(c(orgId, '/products'), { type: 'service', name: 'Consulting', price: 100 });
    await owner.post(c(orgId, '/coupons'), { code: 'SAVE20', type: 'percentage', value: 20 });
    const order = await owner.post(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], couponCode: 'save20' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.subtotal).toBe(100);
    expect(order.body.discount).toBe(20);
    expect(order.body.total).toBe(80);
    expect((await owner.post(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], couponCode: 'NOPE' })).status).toBe(400);
  });

  it('public storefront lists only active products (no auth), hiding operational fields', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Public Widget', price: 5, inventory: 3 });
    const anon = client(); // no login
    const r = await anon.get(`/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBeGreaterThan(0);
    expect(r.body.products.some((p: { name: string }) => p.name === 'Public Widget')).toBe(true);
    expect(r.body.products[0].inventory).toBeUndefined(); // operational field hidden
  });
});

describe('commerce — cart + multi-currency + webhook (deferred P1/P3)', () => {
  it('cart: set item → checkout → order created + cart cleared', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Cart Widget', price: 12, inventory: 5 });
    await owner.put(c(orgId, `/cart/items/${prod.body.productId}`), { quantity: 2 });
    expect((await owner.get(c(orgId, '/cart'))).body.lines).toHaveLength(1);
    const order = await owner.post(c(orgId, '/cart/checkout'), {});
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.subtotal).toBe(24);
    expect((await owner.get(c(orgId, '/cart'))).body.lines).toHaveLength(0); // cleared
    expect((await owner.post(c(orgId, '/cart/checkout'), {})).status).toBe(400); // empty now
  });

  it('rejects a mixed-currency order', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const usd = await owner.post(c(orgId, '/products'), { type: 'service', name: 'A', price: 10, currency: 'USD' });
    const eur = await owner.post(c(orgId, '/products'), { type: 'service', name: 'B', price: 10, currency: 'EUR' });
    const r = await owner.post(c(orgId, '/orders'), { lines: [{ productId: usd.body.productId, quantity: 1 }, { productId: eur.body.productId, quantity: 1 }] });
    expect(r.status).toBe(400);
  });

  it('commerce Stripe webhook reports not_configured in demo-mode', async () => {
    const anon = client();
    const r = await anon.post('/v1/host/openwop-app/commerce/webhook', { type: 'payment_intent.succeeded', data: { object: {} } });
    expect(r.status).toBe(503);
  });
});

describe('commerce — transactional email seam (deferred P6)', () => {
  it('sends only with a recipient + a wired transport (else honest no-op)', async () => {
    const { sendTransactionalEmail, setTransactionalEmailTransport, __resetTransactionalEmail } = await import('../src/features/commerce/transactionalEmail.js');
    __resetTransactionalEmail();
    expect(await sendTransactionalEmail({ to: 'not-an-email', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'no_recipient' });
    expect(await sendTransactionalEmail({ to: 'a@b.com', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'no_transport' });
    const sent: { to: string }[] = [];
    setTransactionalEmailTransport(async (e) => { sent.push(e); return true; });
    expect(await sendTransactionalEmail({ to: 'a@b.com', subject: 'Order confirmed', text: 'Total: 10 USD.' })).toEqual({ sent: true });
    expect(sent[0]?.to).toBe('a@b.com');
    __resetTransactionalEmail();
  });
});

describe('commerce — affiliate commission + payout (deferred P5)', () => {
  it('accrues commission on a paid affiliate-attributed order, then pays out', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const aff = await owner.post(c(orgId, '/affiliates'), { code: 'REF10', name: 'Ref', commissionType: 'percentage', commissionRate: 10 });
    expect(aff.status, JSON.stringify(aff.body)).toBe(201);
    const affiliateId = aff.body.affiliateId;
    const prod = await owner.post(c(orgId, '/products'), { type: 'service', name: 'Course', price: 200 });
    const order = await owner.post(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], affiliateCode: 'ref10' });
    expect(order.body.affiliateCode).toBe('ref10');
    // no commission until paid
    expect((await owner.get(c(orgId, '/affiliates'))).body.affiliates[0].balanceOwed).toBe(0);
    await owner.post(c(orgId, `/orders/${order.body.orderId}/pay`), { paymentIntentId: 'pi_ref' });
    expect((await owner.get(c(orgId, '/affiliates'))).body.affiliates[0].balanceOwed).toBe(20); // 10% of 200
    // payout
    const payout = await owner.post(c(orgId, `/affiliates/${affiliateId}/payout`), {});
    expect(payout.body.amount).toBe(20);
    expect(payout.body.status).toBe('pending');
    expect((await owner.get(c(orgId, '/affiliates'))).body.affiliates[0].balanceOwed).toBe(0); // zeroed
    expect((await owner.get(c(orgId, '/payouts'))).body.payouts).toHaveLength(1);
    // no balance → payout rejected
    expect((await owner.post(c(orgId, `/affiliates/${affiliateId}/payout`), {})).status).toBe(409);
  });
});

describe('commerce — RBAC + isolation', () => {
  it('viewer reads but cannot write; cross-tenant is fenced (404)', async () => {
    await enable('commerce', 'on');
    const { member, orgId } = await ownerWithMember('viewer');
    expect((await member.get(c(orgId, '/products'))).status).toBe(200);
    expect((await member.post(c(orgId, '/products'), { name: 'X', type: 'service', price: 1 })).status).toBe(403);
    const outsider = client(); await outsider.post('/v1/host/openwop-app/test/login', { email: `co-out-${Date.now()}-${n++}@acme.test`, tenantId: `org:other-${Date.now()}-${n++}` });
    expect((await outsider.get(c(orgId, '/products'))).status).toBe(404);
  });
});

describe('commerce — plan-entitlement gate (ADR 0176 correction / gap-analysis A2)', () => {
  it('403s org-scoped routes only when an operator narrows the plan; public store stays open; default unaffected', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('editor');
    // Entitled by default (billing off, no narrowing) — create a live product.
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Gate Widget', price: 3, currency: 'USD' });
    expect(p.status).toBe(201);

    await enable('billing', 'on');
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['crm'] });
    try {
      // Org-scoped operator surface: blocked with the canonical envelope.
      const blocked = await owner.get(c(orgId, '/products'));
      expect(blocked.status).toBe(403);
      expect(blocked.body.error ?? blocked.body.code).toBeDefined();
      // Public storefront: a shopper must NEVER see the merchant's plan error.
      const pub = await owner.get(`/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
      expect(pub.status).toBe(200);
      expect(pub.body.products.some((x: { name: string }) => x.name === 'Gate Widget')).toBe(true);
    } finally {
      delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
      await enable('billing', 'off');
    }
    // Back to default: unaffected.
    expect((await owner.get(c(orgId, '/products'))).status).toBe(200);
  });
});
