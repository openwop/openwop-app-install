/**
 * UCP server adapter (ADR 0178 Phase 1) — ROUTE harness. Covers: toggle gating (the UCP
 * surface 404s when `commerce-ucp` is off), the UCP discovery + OAuth-AS metadata docs,
 * catalog projection (active products only, public/no-auth), admin client provisioning,
 * the client-credentials token endpoint, the cart→checkout→order flow over commerce (no
 * new store), the OAuth scope gate (missing bearer ⇒ 401; wrong scope ⇒ 403), and the
 * cross-org IDOR guard (a token minted for org A does not authenticate against org B).
 */
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Order, Product } from '../src/features/commerce/commerceService.js';
import type { UcpCart, UcpCatalogItem, UcpOrder } from '../src/features/commerce/ucp/ucpAdapter.js';
import type { UcpClientSummary } from '../src/features/commerce/ucp/ucpClientStore.js';

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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}
/** Login + org bodies (the test-auth and orgs routes). */
interface LoginBody extends ErrBody { user: { userId: string; tenantId: string } }
interface OrgBody extends ErrBody { orgId: string }
// An external UCP agent — no cookie, optional bearer.
async function pub<T = ErrBody>(method: string, path: string, body?: unknown, bearer?: string): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let out: T;
  try { out = JSON.parse(text || 'null'); } catch { out = JSON.parse('null'); } // the same single deserialization boundary as `client`
  return { status: res.status, body: out };
}
/** UCP wire bodies — the adapter's exported projections where they exist (ucp/ucpAdapter.ts). */
interface DiscoveryBody extends ErrBody { vertical: string; merchant: { id: string }; transports: { rest: { catalog: string }; mcp: unknown } }
interface OAuthMetaBody extends ErrBody { grant_types_supported: string[] }
interface TokenBody extends ErrBody { access_token: string; token_type: string }
interface CatalogBody extends ErrBody { vertical: string; items: (UcpCatalogItem & { inventory?: undefined })[] }
interface PayBody extends ErrBody { order: UcpOrder; payment: { mode: string; intent_id: string; warnings: string[] } }
type ProvisionBody = UcpClientSummary & ErrBody & { clientSecret: string };
let n = 0;
const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function merchant(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:ucp-${Date.now()}-${n++}`;
  const owner = client(); await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'UCP Shop' });
  return { owner, orgId: org.body.orgId };
}
const admin = (orgId: string, s = '') => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/ucp${s}`;
const ucp = (orgId: string, s = '') => `/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}${s}`;

describe('UCP — toggle gating + discovery', () => {
  it('discovery 404s when commerce-ucp is off, serves the doc when on', async () => {
    await enable('commerce', 'on');
    const { orgId } = await merchant();
    await enable('commerce-ucp', 'off');
    try {
      const off = await pub<DiscoveryBody>('GET', ucp(orgId, '/.well-known/ucp'));
      expect(off.status).toBe(404);
      expect(off.body.message).toBe('Merchant not found.');
    } finally {
      await enable('commerce-ucp', 'on');
    }
    const disc = await pub<DiscoveryBody>('GET', ucp(orgId, '/.well-known/ucp'));
    expect(disc.status).toBe(200);
    expect(disc.body.vertical).toBe('shopping');
    expect(disc.body.merchant.id).toBe(orgId);
    expect(disc.body.transports.rest.catalog).toContain(ucp(orgId, '/catalog'));
    // Phase-1 honesty: MCP/A2A transports are not wired yet, so they are advertised null.
    expect(disc.body.transports.mcp).toBeNull();

    const oas = await pub<OAuthMetaBody>('GET', ucp(orgId, '/.well-known/oauth-authorization-server'));
    expect(oas.status).toBe(200);
    expect(oas.body.grant_types_supported).toContain('client_credentials');
  });

  it('unknown merchant 404s uniformly', async () => {
    await enable('commerce-ucp', 'on');
    expect((await pub<DiscoveryBody>('GET', ucp('org:does-not-exist', '/.well-known/ucp'))).status).toBe(404);
  });
});

describe('UCP — catalog projection (public)', () => {
  it('projects only active products, no internal fields', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    await owner.post<Product & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'physical', name: 'Widget', price: 25, currency: 'USD', inventory: 10 });
    // An INACTIVE product must not be projected (without one, "only active" cannot fail).
    const retired = await owner.post<Product & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'physical', name: 'Retired', price: 5, currency: 'USD', inventory: 1 });
    await owner.patch(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products/${encodeURIComponent(retired.body.productId)}`, { active: false });
    const cat = await pub<CatalogBody>('GET', ucp(orgId, '/catalog'));
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
    const prod = await owner.post<Product & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'digital', name: 'E-book', price: 9, currency: 'USD' });
    const productId = prod.body.productId;

    // Admin provisions a UCP agent client — secret returned ONCE.
    const prov = await owner.post<ProvisionBody>(admin(orgId, '/clients'), { name: 'ChatGPT shopper' });
    expect(prov.status).toBe(201);
    expect(prov.body.clientSecret).toMatch(/^ucps_/);
    expect(prov.body.scopes).toContain('checkout:write');
    const { clientId, clientSecret } = prov.body;

    // Cart write without a bearer ⇒ 401 (fail-closed).
    expect((await pub<UcpCart & ErrBody>('POST', ucp(orgId, '/cart/items'), { item_id: productId, quantity: 2 })).status).toBe(401);

    // client_credentials → bearer.
    const tok = await pub<TokenBody>('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe('Bearer');
    const bearer = tok.body.access_token;

    // Add to cart → projected UCP cart.
    const cart = await pub<UcpCart & ErrBody>('POST', ucp(orgId, '/cart/items'), { item_id: productId, quantity: 2 }, bearer);
    expect(cart.status).toBe(200);
    expect(cart.body.lines).toHaveLength(1);
    expect(cart.body.subtotal).toEqual({ amount: 18, currency: 'USD' });

    // Checkout → a commerce order, projected as a UCP order.
    const checkout = await pub<UcpOrder & ErrBody>('POST', ucp(orgId, '/checkout'), {}, bearer);
    expect(checkout.status).toBe(201);
    expect(checkout.body.status).toBe('pending');
    expect(checkout.body.payment.status).toBe('unpaid');
    expect(checkout.body.totals.total).toEqual({ amount: 18, currency: 'USD' });
    const orderId = checkout.body.id;

    // Order status via bearer.
    const status = await pub<UcpOrder & ErrBody>('GET', ucp(orgId, `/orders/${orderId}`), undefined, bearer);
    expect(status.status).toBe(200);
    expect(status.body.id).toBe(orderId);

    // The SAME order exists in commerce (no parallel store) — the admin sees it.
    const admOrder = await owner.get<Order & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/orders/${orderId}`);
    expect(admOrder.status).toBe(200);
    expect(admOrder.body.total).toBe(18);
  });

  it('bad client secret ⇒ 401 invalid_client', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prov = await owner.post<ProvisionBody>(admin(orgId, '/clients'), { name: 'agent' });
    const bad = await pub<TokenBody>('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('unauthenticated');
    expect(bad.body.message).toBe('invalid_client');
  });

  it('least privilege: an explicitly-empty scope set grants NOTHING (not full access)', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prov = await owner.post<ProvisionBody>(admin(orgId, '/clients'), { name: 'no-scope', scopes: [] });
    expect(prov.status).toBe(201);
    expect(prov.body.scopes).toEqual([]);
    const tok = await pub<TokenBody>('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    // A zero-scope token is rejected on every write (403), never escalated to full access.
    const denied = await pub<UcpCart & ErrBody>('GET', ucp(orgId, '/cart'), undefined, tok.body.access_token);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Missing required scope: cart:write');
  });

  it('admin client provisioning is gated on commerce-ucp (404 when UCP is off)', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    await enable('commerce-ucp', 'off');
    try {
      expect((await owner.get<{ clients: UcpClientSummary[] } & ErrBody>(admin(orgId, '/clients'))).status).toBe(404);
      expect((await owner.post<ProvisionBody>(admin(orgId, '/clients'), { name: 'x' })).status).toBe(404);
    } finally {
      await enable('commerce-ucp', 'on');
    }
    expect((await owner.get<{ clients: UcpClientSummary[] } & ErrBody>(admin(orgId, '/clients'))).body.clients).toEqual([]); // the off-state POST created nothing
    expect((await owner.get<{ clients: UcpClientSummary[] } & ErrBody>(admin(orgId, '/clients'))).status).toBe(200);
  });

  it('scope gate: a cart:write-only token cannot check out (403)', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    const prov = await owner.post<ProvisionBody>(admin(orgId, '/clients'), { name: 'cart-only', scopes: ['cart:write'] });
    const tok = await pub<TokenBody>('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    const co = await pub<UcpOrder & ErrBody>('POST', ucp(orgId, '/checkout'), {}, tok.body.access_token);
    expect(co.status).toBe(403);
    expect(co.body.message).toBe('Missing required scope: checkout:write');
  });

  it('IDOR: a token minted for org A does not authenticate against org B', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const a = await merchant();
    // Org B in the SAME tenant — a different tenant would be refused by the tenant
    // comparison before the org binding is ever consulted.
    const bOrg = await a.owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'UCP Shop B' });
    expect(bOrg.status).toBe(201);
    const bOrgId = bOrg.body.orgId;
    const prov = await a.owner.post<ProvisionBody>(admin(a.orgId, '/clients'), { name: 'a-agent' });
    const tok = await pub<TokenBody>('POST', ucp(a.orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    // Positive control: the token works on its own org.
    expect((await pub<UcpCart & ErrBody>('GET', ucp(a.orgId, '/cart'), undefined, tok.body.access_token)).status).toBe(200);
    // Using A's token against B's cart ⇒ 401 (token bound to A's org). Double guard: the
    // token row's orgId AND its client's orgId are both compared in verifyToken
    // (ucp/ucpClientStore.ts) — removing either alone keeps this 401.
    const cross = await pub<UcpCart & ErrBody>('GET', ucp(bOrgId, '/cart'), undefined, tok.body.access_token);
    expect(cross.status).toBe(401);
    expect(cross.body.message).toBe('A valid UCP bearer token is required.');
  });
});

// A carted, checked-out order + a full-scope bearer, ready for AP2 payment.
async function agentOrderReady(): Promise<{ owner: Client; orgId: string; bearer: string; orderId: string; total: number }> {
  await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
  const { owner, orgId } = await merchant();
  const prod = await owner.post<Product & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
  const prov = await owner.post<ProvisionBody>(admin(orgId, '/clients'), { name: 'shopper' });
  const tok = await pub<TokenBody>('POST', ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
  const bearer = tok.body.access_token;
  await pub<UcpCart & ErrBody>('POST', ucp(orgId, '/cart/items'), { item_id: prod.body.productId, quantity: 1 }, bearer);
  const checkout = await pub<UcpOrder & ErrBody>('POST', ucp(orgId, '/checkout'), {}, bearer);
  return { owner, orgId, bearer, orderId: checkout.body.id, total: 40 };
}

describe('UCP — AP2 payment + lifecycle (Phase 3)', () => {
  it('an AP2 mandate settles the order (demo-mode) — the whole commerce lifecycle rides', async () => {
    const { orgId, bearer, orderId, total } = await agentOrderReady();
    const pay = await pub<PayBody>('POST', ucp(orgId, `/orders/${orderId}/pay`), { ap2_mandate: { id: 'mnd_1', amount: total, currency: 'USD' } }, bearer);
    expect(pay.status).toBe(200);
    expect(pay.body.order.status).toBe('paid');
    expect(pay.body.order.payment.status).toBe('paid');
    expect(pay.body.payment.mode).toBe('demo');
    expect(pay.body.payment.intent_id).toBe('ap2:mnd_1');
    // Honesty: the VC is NOT claimed as verified.
    expect(pay.body.payment.warnings.join(' ')).toContain('not_cryptographically_verified');
  });

  it('rejects a mandate whose amount does not match the order total (400)', async () => {
    const { owner, orgId, bearer, orderId } = await agentOrderReady();
    const pay = await pub<PayBody>('POST', ucp(orgId, `/orders/${orderId}/pay`), { ap2_mandate: { amount: 5, currency: 'USD' } }, bearer);
    expect(pay.status).toBe(400);
    expect(pay.body.message).toMatch(/does not match the order charge/);
    // Money truth: the persisted order is still unpaid.
    const stored = await owner.get<Order & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/orders/${encodeURIComponent(orderId)}`);
    expect(stored.body.status).toBe('pending');
    expect(stored.body.paymentIntentId).toBeUndefined();
  });

  it('requires a mandate or a payment_intent_id (400)', async () => {
    const { owner, orgId, bearer, orderId } = await agentOrderReady();
    const pay = await pub<PayBody>('POST', ucp(orgId, `/orders/${orderId}/pay`), {}, bearer);
    expect(pay.status).toBe(400);
    expect(pay.body.message).toMatch(/requires either `payment_intent_id` or `ap2_mandate`/);
    expect((await owner.get<Order & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/orders/${encodeURIComponent(orderId)}`)).body.status).toBe('pending');
  });

  it('a buyer-agent can cancel a pending order; paying a canceled order 409s', async () => {
    const { owner, orgId, bearer, orderId } = await agentOrderReady();
    const cancel = await pub<UcpOrder & ErrBody>('POST', ucp(orgId, `/orders/${orderId}/cancel`), {}, bearer);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('canceled');
    const pay = await pub<PayBody>('POST', ucp(orgId, `/orders/${orderId}/pay`), { payment_intent_id: 'pi_x' }, bearer);
    expect(pay.status).toBe(409);
    expect(pay.body.message).toMatch(/Only a pending order can be marked paid/);
    expect((await owner.get<Order & ErrBody>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/orders/${encodeURIComponent(orderId)}`)).body.status).toBe('canceled');
  });
});
