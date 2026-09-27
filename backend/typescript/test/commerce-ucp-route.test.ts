/**
 * UCP server adapter (ADR 0178 Phase 1) — ROUTE harness. Covers: toggle gating (the UCP
 * surface 404s when `commerce-ucp` is off), the UCP discovery + OAuth-AS metadata docs,
 * catalog projection (active products only, public/no-auth), admin client provisioning,
 * the client-credentials token endpoint, the cart→checkout→order flow over commerce (no
 * new store), the OAuth scope gate (missing bearer ⇒ 401; wrong scope ⇒ 403), and the
 * cross-org IDOR guard (a token minted for org A does not authenticate against org B).
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
// An external UCP agent — no cookie, optional bearer.
async function pub(method: string, path: string, body?: unknown, bearer?: string): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: out };
}
let n = 0;
const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function merchant(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const tenantId = `org:ucp-${Date.now()}-${n++}`;
  const owner = client(); await owner.post('/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/host/openwop-app/orgs', { name: 'UCP Shop' });
  return { owner, orgId: org.body.orgId };
}
const admin = (orgId: string, s = '') => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/ucp${s}`;
const ucp = (orgId: string, s = '') => `/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}${s}`;

describe('UCP — toggle gating + discovery', () => {
  it('discovery 404s when commerce-ucp is off, serves the doc when on', async () => {
    await enable('commerce', 'on');
    const { orgId } = await merchant();
    await enable('commerce-ucp', 'off');
    expect((await pub('GET', ucp(orgId, '/.well-known/ucp'))).status).toBe(404);

    await enable('commerce-ucp', 'on');
    const disc = await pub('GET', ucp(orgId, '/.well-known/ucp'));
    expect(disc.status).toBe(200);
    expect(disc.body.vertical).toBe('shopping');
    expect(disc.body.merchant.id).toBe(orgId);
    expect(disc.body.transports.rest.catalog).toContain(ucp(orgId, '/catalog'));
    // Phase-1 honesty: MCP/A2A transports are not wired yet, so they are advertised null.
    expect(disc.body.transports.mcp).toBeNull();

    const oas = await pub('GET', ucp(orgId, '/.well-known/oauth-authorization-server'));
    expect(oas.status).toBe(200);
    expect(oas.body.grant_types_supported).toContain('client_credentials');
  });

  it('unknown merchant 404s uniformly', async () => {
    await enable('commerce-ucp', 'on');
    expect((await pub('GET', ucp('org:does-not-exist', '/.well-known/ucp'))).status).toBe(404);
  });
});

describe('UCP — catalog projection (public)', () => {
  it('projects only active products, no internal fields', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    await owner.post(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'physical', name: 'Widget', price: 25, currency: 'USD', inventory: 10 });
    const cat = await pub('GET', ucp(orgId, '/catalog'));
    expect(cat.status).toBe(200);
    expect(cat.body.vertical).toBe('shopping');
    expect(cat.body.items).toHaveLength(1);
    const item = cat.body.items[0];
    expect(item.title).toBe('Widget');
    expect(item.price).toEqual({ amount: 25, currency: 'USD' });
    expect(item.availability).toBe('in_stock');
    // Never leak the operational inventory count over the agent surface.
    expect(item.inventory).toBeUndefined();
  });
});

describe('UCP — auth + cart→checkout→order over commerce', () => {
  it('provisions a client, mints a token, carts, checks out, tracks the order', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prod = await owner.post(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'digital', name: 'E-book', price: 9, currency: 'USD' });
    const productId = prod.body.productId;

    // Admin provisions a UCP agent client — secret returned ONCE.
    const prov = await owner.post(admin(orgId, '/clients'), { name: 'ChatGPT shopper' });
    expect(prov.status).toBe(201);
    expect(prov.body.clientSecret).toMatch(/^ucps_/);
    expect(prov.body.scopes).toContain('checkout:write');
    const { clientId, clientSecret } = prov.body;

    // Cart write without a bearer ⇒ 401 (fail-closed).
    expect((await pub('POST', ucp(orgId, '/cart/items'), { item_id: productId, quantity: 2 })).status).toBe(401);

    // client_credentials → bearer.
    const tok = await pub('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe('Bearer');
    const bearer = tok.body.access_token;

    // Add to cart → projected UCP cart.
    const cart = await pub('POST', ucp(orgId, '/cart/items'), { item_id: productId, quantity: 2 }, bearer);
    expect(cart.status).toBe(200);
    expect(cart.body.lines).toHaveLength(1);
    expect(cart.body.subtotal).toEqual({ amount: 18, currency: 'USD' });

    // Checkout → a commerce order, projected as a UCP order.
    const checkout = await pub('POST', ucp(orgId, '/checkout'), {}, bearer);
    expect(checkout.status).toBe(201);
    expect(checkout.body.status).toBe('pending');
    expect(checkout.body.payment.status).toBe('unpaid');
    expect(checkout.body.totals.total).toEqual({ amount: 18, currency: 'USD' });
    const orderId = checkout.body.id;

    // Order status via bearer.
    const status = await pub('GET', ucp(orgId, `/orders/${orderId}`), undefined, bearer);
    expect(status.status).toBe(200);
    expect(status.body.id).toBe(orderId);

    // The SAME order exists in commerce (no parallel store) — the admin sees it.
    const admOrder = await owner.get(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/orders/${orderId}`);
    expect(admOrder.status).toBe(200);
    expect(admOrder.body.total).toBe(18);
  });

  it('bad client secret ⇒ 401 invalid_client', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prov = await owner.post(admin(orgId, '/clients'), { name: 'agent' });
    const bad = await pub('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error?.message ?? bad.body.message).toBe('invalid_client');
  });

  it('least privilege: an explicitly-empty scope set grants NOTHING (not full access)', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prov = await owner.post(admin(orgId, '/clients'), { name: 'no-scope', scopes: [] });
    expect(prov.status).toBe(201);
    expect(prov.body.scopes).toEqual([]);
    const tok = await pub('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    // A zero-scope token is rejected on every write (403), never escalated to full access.
    expect((await pub('GET', ucp(orgId, '/cart'), undefined, tok.body.access_token)).status).toBe(403);
  });

  it('admin client provisioning is gated on commerce-ucp (404 when UCP is off)', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    await enable('commerce-ucp', 'off');
    expect((await owner.get(admin(orgId, '/clients'))).status).toBe(404);
    expect((await owner.post(admin(orgId, '/clients'), { name: 'x' })).status).toBe(404);
    await enable('commerce-ucp', 'on');
    expect((await owner.get(admin(orgId, '/clients'))).status).toBe(200);
  });

  it('scope gate: a cart:write-only token cannot check out (403)', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prov = await owner.post(admin(orgId, '/clients'), { name: 'cart-only', scopes: ['cart:write'] });
    const tok = await pub('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    const co = await pub('POST', ucp(orgId, '/checkout'), {}, tok.body.access_token);
    expect(co.status).toBe(403);
  });

  it('IDOR: a token minted for org A does not authenticate against org B', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const a = await merchant();
    const b = await merchant();
    const prov = await a.owner.post(admin(a.orgId, '/clients'), { name: 'a-agent' });
    const tok = await pub('POST', ucp(a.orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    // Using A's token against B's cart ⇒ 401 (token bound to A's org).
    const cross = await pub('GET', ucp(b.orgId, '/cart'), undefined, tok.body.access_token);
    expect(cross.status).toBe(401);
  });
});

// A carted, checked-out order + a full-scope bearer, ready for AP2 payment.
async function agentOrderReady(): Promise<{ orgId: string; bearer: string; orderId: string; total: number }> {
  await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
  const { owner, orgId } = await merchant();
  const prod = await owner.post(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
  const prov = await owner.post(admin(orgId, '/clients'), { name: 'shopper' });
  const tok = await pub('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
  const bearer = tok.body.access_token;
  await pub('POST', ucp(orgId, '/cart/items'), { item_id: prod.body.productId, quantity: 1 }, bearer);
  const checkout = await pub('POST', ucp(orgId, '/checkout'), {}, bearer);
  return { orgId, bearer, orderId: checkout.body.id, total: 40 };
}

describe('UCP — AP2 payment + lifecycle (Phase 3)', () => {
  it('an AP2 mandate settles the order (demo-mode) — the whole commerce lifecycle rides', async () => {
    const { orgId, bearer, orderId, total } = await agentOrderReady();
    const pay = await pub('POST', ucp(orgId, `/orders/${orderId}/pay`), { ap2_mandate: { id: 'mnd_1', amount: total, currency: 'USD' } }, bearer);
    expect(pay.status).toBe(200);
    expect(pay.body.order.status).toBe('paid');
    expect(pay.body.order.payment.status).toBe('paid');
    expect(pay.body.payment.mode).toBe('demo');
    expect(pay.body.payment.intent_id).toBe('ap2:mnd_1');
    // Honesty: the VC is NOT claimed as verified.
    expect(pay.body.payment.warnings.join(' ')).toContain('not_cryptographically_verified');
  });

  it('rejects a mandate whose amount does not match the order total (400)', async () => {
    const { orgId, bearer, orderId } = await agentOrderReady();
    const pay = await pub('POST', ucp(orgId, `/orders/${orderId}/pay`), { ap2_mandate: { amount: 5, currency: 'USD' } }, bearer);
    expect(pay.status).toBe(400);
  });

  it('requires a mandate or a payment_intent_id (400)', async () => {
    const { orgId, bearer, orderId } = await agentOrderReady();
    expect((await pub('POST', ucp(orgId, `/orders/${orderId}/pay`), {}, bearer)).status).toBe(400);
  });

  it('a buyer-agent can cancel a pending order; paying a canceled order 409s', async () => {
    const { orgId, bearer, orderId } = await agentOrderReady();
    const cancel = await pub('POST', ucp(orgId, `/orders/${orderId}/cancel`), {}, bearer);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('canceled');
    const pay = await pub('POST', ucp(orgId, `/orders/${orderId}/pay`), { payment_intent_id: 'pi_x' }, bearer);
    expect(pay.status).toBe(409);
  });
});
