/**
 * E-Commerce (ADR 0177) — ROUTE harness: toggle gating, product CRUD, order create +
 * the lifecycle state machine (pay→inventory decrement, refund→restore, cancel guard,
 * fulfillment→delivered flips to fulfilled), RBAC, IDOR, CRM contactId validation.
 */
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createContact } from '../src/features/crm/contactsService.js';
import type { Cart, Coupon, Order, Product } from '../src/features/commerce/commerceService.js';
import type { Affiliate, Payout } from '../src/features/commerce/affiliate.js';

function portOf(s: http.Server): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}
let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = ErrBody>(p: string) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  // The ONE deserialization boundary: `res.json()` is untyped, so each call site names the
  // body it expects (the product's exported row type where one exists, else a narrow local
  // interface). A 204 / non-JSON body reads as `null`.
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    const text = await res.text();
    let out: T;
    try { out = JSON.parse(text || 'null'); } catch { out = JSON.parse('null'); }
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}
/** Login + org bodies (the test-auth and orgs routes). */
interface LoginBody extends ErrBody { user: { userId: string; tenantId: string } }
interface OrgBody extends ErrBody { orgId: string }
let n = 0;
const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client(); await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client(); const mr = await member.post<LoginBody>('/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Shop' }); const orgId = org.body.orgId;
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: mr.body.user.userId, roles: [role] });
  return { owner, member, orgId, tenantId };
}
/** The public storefront's product projection (commerce/routes.ts) — operational fields are never present. */
interface PublicProductBody { productId: string; name: string; inventory?: undefined; cost?: undefined }
const c = (orgId: string, suffix = '') => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('commerce — toggle gating', () => {
  it('404s when off', async () => {
    await enable('commerce', 'off');
    try {
      const { owner, orgId } = await ownerWithMember('viewer');
      const r = await owner.get<{ products: Product[] } & ErrBody>(c(orgId, '/products'));
      expect(r.status).toBe(404);
      expect(r.body.message).toMatch(/not enabled for this tenant/);
    } finally {
      await enable('commerce', 'on');
    }
  });
});

describe('commerce — product CRUD + order lifecycle', () => {
  it('creates a physical product, orders it (reserves stock at create), pays, refunds (restores)', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'physical', name: 'Widget', price: 25, currency: 'USD', inventory: 10 });
    expect(prod.status, JSON.stringify(prod.body)).toBe(201);
    const productId = prod.body.productId;

    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId, quantity: 3 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.subtotal).toBe(75);
    expect(order.body.status).toBe('pending');
    const orderId = order.body.orderId;
    expect((await owner.get<Product & ErrBody>(c(orgId, `/products/${productId}`))).body.inventory).toBe(7); // C5: reserved at create

    const paid = await owner.post<Order & ErrBody>(c(orgId, `/orders/${orderId}/pay`), { paymentIntentId: 'pi_ext_123' });
    expect(paid.body.status).toBe('paid');
    expect(paid.body.paymentIntentId).toBe('pi_ext_123');
    expect((await owner.get<Product & ErrBody>(c(orgId, `/products/${productId}`))).body.inventory).toBe(7); // pay consumes the reservation

    const refunded = await owner.post<Order & ErrBody>(c(orgId, `/orders/${orderId}/refund`), {});
    expect(refunded.body.status).toBe('refunded');
    const stored = (await owner.get<Order & ErrBody>(c(orgId, `/orders/${orderId}`))).body; // money truth = the persisted row
    expect(stored.status).toBe('refunded');
    expect(stored.refundedAmount).toBe(75);
    expect((await owner.get<Product & ErrBody>(c(orgId, `/products/${productId}`))).body.inventory).toBe(10); // restored
  });

  it('fulfillment → delivered flips the order to fulfilled; lifecycle guards hold', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'digital', name: 'Ebook', price: 9 });
    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }] });
    const orderId = order.body.orderId;
    // cannot fulfill a pending (unpaid) order
    const early = await owner.post<Order & ErrBody>(c(orgId, `/orders/${orderId}/fulfillment`), { fulfillmentStatus: 'shipped' });
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/Fulfillment applies to a paid order/);
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${orderId}/pay`), { paymentIntentId: 'pi_x' });
    const delivered = await owner.post<Order & ErrBody>(c(orgId, `/orders/${orderId}/fulfillment`), { fulfillmentStatus: 'delivered' });
    expect(delivered.body.fulfillmentStatus).toBe('delivered');
    expect(delivered.body.status).toBe('fulfilled');
    // cannot cancel a fulfilled order (only pending)
    const cancel = await owner.post<Order & ErrBody>(c(orgId, `/orders/${orderId}/cancel`), {});
    expect(cancel.status).toBe(409);
    expect(cancel.body.message).toMatch(/Only a pending order can be canceled/);
    expect((await owner.get<Order & ErrBody>(c(orgId, `/orders/${orderId}`))).body.status).toBe('fulfilled');
  });

  it('rejects a foreign contactId + an order with an unknown product', async () => {
    await enable('commerce', 'on');
    const { owner, orgId, tenantId } = await ownerWithMember('owner');
    const prod = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'service', name: 'Svc', price: 5 });
    const lines = [{ productId: prod.body.productId, quantity: 1 }];
    // A REAL contact in ANOTHER tenant (a missing id would only prove 404-on-missing).
    const foreign = await createContact({ tenantId: `org:foreign-${Date.now()}-${n++}`, name: 'Elsewhere' });
    const own = await createContact({ tenantId, name: 'Mine' });
    const rejected = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { contactId: foreign.contactId, lines });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toMatch(/contactId does not reference a contact in this tenant/);
    // Positive control: the same request with this tenant's contact goes through.
    const ok = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { contactId: own.contactId, lines });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.contactId).toBe(own.contactId);
    const unknown = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: 'prod:nope', quantity: 1 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/Product not found: prod:nope/);
  });
});

describe('commerce — coupons + public storefront (Phases 2-3)', () => {
  it('applies a coupon (discount + total) and rejects an invalid code', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'service', name: 'Consulting', price: 100 });
    await owner.post<Coupon & ErrBody>(c(orgId, '/coupons'), { code: 'SAVE20', type: 'percentage', value: 20 });
    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], couponCode: 'save20' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.subtotal).toBe(100);
    expect(order.body.discount).toBe(20);
    expect(order.body.total).toBe(80);
    const badCoupon = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], couponCode: 'NOPE' });
    expect(badCoupon.status).toBe(400);
    expect(badCoupon.body.message).toMatch(/Invalid or inactive coupon code/);
  });

  it('public storefront lists only active products (no auth), hiding operational fields', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'physical', name: 'Public Widget', price: 5, inventory: 3, cost: 2 });
    const hidden = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'physical', name: 'Retired Widget', price: 5, inventory: 3 });
    expect((await owner.patch<Product & ErrBody>(c(orgId, `/products/${hidden.body.productId}`), { active: false })).body.active).toBe(false);
    const anon = client(); // no login
    const r = await anon.get<{ products: PublicProductBody[] } & ErrBody>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
    expect(r.status).toBe(200);
    const names = r.body.products.map((p) => p.name);
    expect(names).toEqual(['Public Widget']); // the inactive product is not listed
    expect(r.body.products[0].inventory).toBeUndefined(); // operational fields hidden
    expect(r.body.products[0].cost).toBeUndefined();
  });
});

describe('commerce — cart + multi-currency + webhook (deferred P1/P3)', () => {
  it('cart: set item → checkout → order created + cart cleared', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const prod = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'physical', name: 'Cart Widget', price: 12, inventory: 5 });
    await owner.put<Cart & ErrBody>(c(orgId, `/cart/items/${prod.body.productId}`), { quantity: 2 });
    expect((await owner.get<Cart & ErrBody>(c(orgId, '/cart'))).body.lines).toHaveLength(1);
    const order = await owner.post<Order & ErrBody>(c(orgId, '/cart/checkout'), {});
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.subtotal).toBe(24);
    expect((await owner.get<Cart & ErrBody>(c(orgId, '/cart'))).body.lines).toHaveLength(0); // cleared
    expect((await owner.post<Order & ErrBody>(c(orgId, '/cart/checkout'), {})).status).toBe(400); // empty now
  });

  it('rejects a mixed-currency order', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const usd = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'service', name: 'A', price: 10, currency: 'USD' });
    const eur = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'service', name: 'B', price: 10, currency: 'EUR' });
    const r = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: usd.body.productId, quantity: 1 }, { productId: eur.body.productId, quantity: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/must share one currency/);
  });

  it('commerce Stripe webhook reports not_configured in demo-mode', async () => {
    const anon = client();
    const r = await anon.post('/host/openwop-app/commerce/webhook', { type: 'payment_intent.succeeded', data: { object: {} } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_configured');
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
    const aff = await owner.post<Affiliate & ErrBody>(c(orgId, '/affiliates'), { code: 'REF10', name: 'Ref', commissionType: 'percentage', commissionRate: 10 });
    expect(aff.status, JSON.stringify(aff.body)).toBe(201);
    const affiliateId = aff.body.affiliateId;
    const prod = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'service', name: 'Course', price: 200 });
    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], affiliateCode: 'ref10' });
    expect(order.body.affiliateCode).toBe('ref10');
    // no commission until paid
    expect((await owner.get<{ affiliates: Affiliate[] } & ErrBody>(c(orgId, '/affiliates'))).body.affiliates[0].balanceOwed).toBe(0);
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${order.body.orderId}/pay`), { paymentIntentId: 'pi_ref' });
    expect((await owner.get<{ affiliates: Affiliate[] } & ErrBody>(c(orgId, '/affiliates'))).body.affiliates[0].balanceOwed).toBe(20); // 10% of 200
    // payout
    const payout = await owner.post<Payout & ErrBody>(c(orgId, `/affiliates/${affiliateId}/payout`), {});
    expect(payout.body.amount).toBe(20);
    expect(payout.body.status).toBe('pending');
    expect((await owner.get<{ affiliates: Affiliate[] } & ErrBody>(c(orgId, '/affiliates'))).body.affiliates[0].balanceOwed).toBe(0); // zeroed
    expect((await owner.get<{ payouts: Payout[] } & ErrBody>(c(orgId, '/payouts'))).body.payouts).toHaveLength(1);
    // no balance → payout rejected
    expect((await owner.post<Payout & ErrBody>(c(orgId, `/affiliates/${affiliateId}/payout`), {})).status).toBe(409);
  });
});

describe('commerce — RBAC + isolation', () => {
  it('viewer reads but cannot write; cross-tenant is fenced (404)', async () => {
    await enable('commerce', 'on');
    const { member, orgId } = await ownerWithMember('viewer');
    expect((await member.get<{ products: Product[] } & ErrBody>(c(orgId, '/products'))).status).toBe(200);
    const denied = await member.post<Product & ErrBody>(c(orgId, '/products'), { name: 'X', type: 'service', price: 1 });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/workspace:write/);
    expect((await member.get<{ products: Product[] } & ErrBody>(c(orgId, '/products'))).body.products).toEqual([]); // nothing was written
    const outsider = client(); await outsider.post<LoginBody>('/host/openwop-app/test/login', { email: `co-out-${Date.now()}-${n++}@acme.test`, tenantId: `org:other-${Date.now()}-${n++}` });
    expect((await outsider.get<{ products: Product[] } & ErrBody>(c(orgId, '/products'))).status).toBe(404);
  });
});

describe('commerce — plan-entitlement gate (ADR 0176 correction / gap-analysis A2)', () => {
  it('403s org-scoped routes only when an operator narrows the plan; public store stays open; default unaffected', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('editor');
    // Entitled by default (billing off, no narrowing) — create a live product.
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'physical', name: 'Gate Widget', price: 3, currency: 'USD' });
    expect(p.status).toBe(201);

    // Double guard (round-1 probe removing commerce's own `checkEntitlement` was vacuous):
    // the central `requireFeatureEnabled` choke (features/featureRoute.ts, ADR 0419) runs the
    // SAME `checkEntitlement` for every sellable-bundle toggle, so commerce's extra call in
    // its `authz` helper is redundant. This case guards the OUTCOME through either.
    await enable('billing', 'on');
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['crm'] });
    try {
      // Org-scoped operator surface: blocked with the canonical envelope.
      const blocked = await owner.get<{ products: Product[] } & ErrBody>(c(orgId, '/products'));
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBeDefined();
      // Public storefront: a shopper must NEVER see the merchant's plan error.
      const pub = await owner.get<{ products: PublicProductBody[] } & ErrBody>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
      expect(pub.status).toBe(200);
      expect(pub.body.products.some((x: { name: string }) => x.name === 'Gate Widget')).toBe(true);
    } finally {
      delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
      await enable('billing', 'off');
    }
    // Back to default: unaffected.
    expect((await owner.get<{ products: Product[] } & ErrBody>(c(orgId, '/products'))).status).toBe(200);
  });
});
