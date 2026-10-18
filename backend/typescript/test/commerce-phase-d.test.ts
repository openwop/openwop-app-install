/**
 * Ecommerce gap plan §5D Phase D — backend behavior:
 *  - D1 customer-identity floor: a commerce_order share link renders a PII-free
 *    status view; the confirmation email carries the tracking link;
 *  - D2 UCP buyer (ADR 0188 floor): discover/search against a mock merchant,
 *    AP2 mandate integrity (intent ceiling), the fail-closed org cap, the
 *    ALWAYS approval gate (approve → placed, idempotent re-checkout), tracking;
 *  - D3 assortments: an exclusive-assortment buyer can buy/quote ONLY carried
 *    products; anonymous buyers unaffected; the price preview answers sellable;
 *  - D4 refunds: demo/manual intents stay state-only (refundProvider 'none' in
 *    the audit row); shippingAddress is captured bounded.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import type { UcpPurchase } from '../src/features/commerce/ucpBuyer/ucpBuyerService.js';
import type { ResolvedPrice } from '../src/features/commerce/pricing.js';
import type { Product, Order } from '../src/features/commerce/commerceService.js';
import type { Contact } from '../src/features/crm/contactsService.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { resolveShared } from '../src/features/sharing/sharingService.js';
import { setTransactionalEmailTransport, __resetTransactionalEmail, type TransactionalEmail } from '../src/features/commerce/transactionalEmail.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}

let BASE: string; let server: http.Server; let n = 0;
let merchant: http.Server; let MERCHANT_URL = '';
const merchantOrders = new Map<string, { status: string }>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // loopback mock merchant
  process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'commerce-ucp-buyer', 'crm', 'sharing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // Mock UCP merchant.
  merchant = http.createServer((req, res) => {
    const url = req.url ?? '';
    const json = (code: number, body: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/.well-known/ucp') return json(200, { ucp: '1.0', vertical: 'shopping', endpoints: { catalog: '/catalog', checkout: '/checkout' } });
    if (url.startsWith('/catalog')) return json(200, { products: [{ productId: 'ext-1', name: 'Ext Widget', price: 12, currency: 'USD' }] });
    if (url === '/checkout' && req.method === 'POST') { const id = `ext-ord-${merchantOrders.size + 1}`; merchantOrders.set(id, { status: 'pending' }); return json(201, { orderId: id }); }
    const m = url.match(/^\/orders\/(.+)$/);
    if (m) { const o = merchantOrders.get(decodeURIComponent(m[1])); return o ? json(200, { status: o.status }) : json(404, {}); }
    return json(404, {});
  });
  await new Promise<void>((res) => { merchant.listen(0, '127.0.0.1', () => { MERCHANT_URL = `http://127.0.0.1:${portOf(merchant)}`; res(); }); });
});
// The org spend cap is set INSIDE D2; never let it reach another case.
afterEach(() => { delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR; });
afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
  __resetTransactionalEmail();
  await new Promise<void>((res) => merchant.close(() => res()));
  await new Promise<void>((res) => server.close(() => res()));
});

/** Read one field of an untyped value (an audit payload) without a cast. */
function at(v: unknown, ...path: string[]): unknown {
  let cur: unknown = v;
  for (const k of path) cur = cur !== null && typeof cur === 'object' ? Reflect.get(cur, k) : undefined;
  return cur;
}
/** The ONE untyped boundary: `JSON.parse` returns the declared `T` (the call
 *  site's statement of the shape it reads). An empty or non-JSON body is `null`. */
function parseBody<T>(text: string): T {
  try { return JSON.parse(text === '' ? 'null' : text); } catch { return JSON.parse('null'); }
}
/** The canonical error envelope a refused call carries. */
interface ApiError { error: string; message?: string; details?: Record<string, unknown> }
/** A response whose body shape the CALL SITE names (`owner.post<Product>(…)`);
 *  unread bodies stay `unknown`, so a field read without a named shape fails tsc. */
interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: parseBody<T>(await res.text()) };
  };
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b), patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b) };
}
/** The body is EITHER the success shape OR the error envelope — every field of both optional. */
type OrError<T> = Partial<T> & Partial<ApiError>;
/** The price preview: the resolved price plus whether the buyer may buy it. */
interface PricePreview extends ResolvedPrice { sellable?: boolean; sellableReason?: string }
interface LoginBody { user?: { userId: string; tenantId?: string }; tenantId?: string }
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `pd-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = r.body.user?.tenantId ?? '';
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;
const buyer = (orgId: string, suffix = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/ucp-buyer${suffix}`;

describe('D1 — order-status share links (the identity floor)', () => {
  it('renders a PII-free markdown status view and the confirmation email carries the link', async () => {
    const { owner, orgId } = await shopOwner();
    const sent: TransactionalEmail[] = [];
    setTransactionalEmailTransport(async (e) => { sent.push(e); return true; });
    try {
      const email = `track-${n++}@x.test`;
      const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Track Me', email });
      // A PHYSICAL order with a shipping address: the PII a status view could leak
      // must actually EXIST on the order, or "no PII" cannot fail (measured vacuous).
      const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Track Guide', price: 6, currency: 'USD', inventory: 5 });
      const o = await owner.post<Order>(c(orgId, '/orders'), {
        contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }],
        shippingAddress: { name: 'Ada Recipient', line1: '9 Secret Lane', city: 'Hiddenville', postalCode: '99999', country: 'US' },
      });
      expect(o.body.shippingAddress).toMatchObject({ name: 'Ada Recipient', line1: '9 Secret Lane' }); // the PII is there
      const paid = await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi_d1' });
      expect(paid.status).toBe(200);

      // Confirmation email carries a /shared/ tracking link.
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('https://app.example.test/shared/');

      // The link renders the status view — and none of the buyer's identity.
      const token = sent[0].text.split('/shared/')[1].trim();
      const shared = await resolveShared(token);
      expect(shared.resourceType).toBe('commerce_order');
      const md = String(shared.resource.markdown);
      expect(md).toContain('**Status:** paid');
      expect(md).toContain('Track Guide');
      for (const pii of [email, 'Track Me', 'Ada Recipient', '9 Secret Lane', 'Hiddenville', '99999']) {
        expect(md, `share view leaks ${pii}`).not.toContain(pii);
      }
    } finally {
      __resetTransactionalEmail();
    }
  });
});

describe('D2 — UCP buyer (ADR 0188 floor)', () => {
  it('discovers + searches a merchant, enforces the intent ceiling, the org cap, and the ALWAYS approval; placement is idempotent; tracking reads status', async () => {
    const { owner, orgId, tenantId } = await shopOwner();

    // Discover + search through the egress gate.
    const disco = await owner.post<{ discovery: { ucp?: string } }>(buyer(orgId, '/discover'), { merchantUrl: MERCHANT_URL });
    expect(disco.status, JSON.stringify(disco.body)).toBe(200);
    expect(disco.body.discovery.ucp).toBe('1.0');
    const cat = await owner.post<{ catalog: { products: Array<{ name: string }> } }>(buyer(orgId, '/catalog-search'), { merchantUrl: MERCHANT_URL, q: 'widget' });
    expect(cat.body.catalog.products[0].name).toBe('Ext Widget');

    // Intent ceiling: a cart over the authorized max refuses.
    const over = await owner.post<ApiError>(buyer(orgId, '/purchases'), {
      merchantUrl: MERCHANT_URL, intent: 'Buy widgets under $10', maxAmountMinor: 1000, currency: 'USD',
      lines: [{ externalProductId: 'ext-1', name: 'Ext Widget', quantity: 1, unitPriceMinor: 1200 }],
    });
    expect(over.status).toBe(409);

    // Draft within the ceiling.
    const draft = await owner.post<UcpPurchase>(buyer(orgId, '/purchases'), {
      merchantUrl: MERCHANT_URL, intent: 'Buy one widget under $15', maxAmountMinor: 1500, currency: 'USD',
      lines: [{ externalProductId: 'ext-1', name: 'Ext Widget', quantity: 1, unitPriceMinor: 1200 }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const purchaseId: string = draft.body.purchaseId;
    expect(draft.body.cartMandate.totalMinor).toBe(1200);

    // Org cap fail-closed: UNSET ⇒ purchasing disabled.
    delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    const capped = await owner.post<OrError<UcpPurchase>>(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(capped.status).toBe(403);
    expect(capped.body.details?.code).toBe('spend_cap');

    // Cap set → the ALWAYS approval parks.
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000';
    const parked = await owner.post<OrError<UcpPurchase>>(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(parked.status).toBe(409);
    expect(parked.body.error).toBe('approval_required');
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    expect(appr?.kind).toBe('commerce-spend');
    expect(appr?.amountMinor).toBe(1200);

    // Approve → placed with the merchant; payment mandate carries the honesty warning.
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    const placed = await owner.post<OrError<UcpPurchase>>(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body.status).toBe('placed');
    expect(placed.body.extOrderId).toMatch(/^ext-ord-/);
    expect(placed.body.paymentMandate?.warnings[0]).toContain('ap2_vc_signing_not_configured');

    // Idempotent: a re-checkout never re-posts to the merchant.
    const before = merchantOrders.size;
    const again = await owner.post<OrError<UcpPurchase>>(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(again.body.status).toBe('placed');
    expect(merchantOrders.size).toBe(before);

    // Tracking reads the merchant's status.
    const extOrder = merchantOrders.get(placed.body.extOrderId ?? '');
    expect(extOrder).toBeDefined();
    if (extOrder) extOrder.status = 'shipped';
    const tracked = await owner.post<UcpPurchase>(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/track`));
    expect(tracked.body.extStatus).toBe('shipped');
  });
});

describe('D3 — account-native assortments', () => {
  it('an exclusive-assortment buyer can order/quote only carried products; anonymous unaffected; the preview says why', async () => {
    const { owner, orgId } = await shopOwner();
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Assorted', email: `as-${n++}@x.test` });
    const contactId: string = contact.body.contactId;
    const inA = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Allowed', price: 10, currency: 'USD', inventory: 10 });
    const outB = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Forbidden', price: 10, currency: 'USD', inventory: 10 });
    await owner.post(c(orgId, '/price-lists'), { name: 'Contract A', currency: 'USD', priority: 1, contactIds: [contactId], exclusiveAssortment: true, entries: [{ productId: inA.body.productId, price: 9 }] });

    // In-assortment order succeeds at the contract price; out-of-assortment 409s.
    const ok = await owner.post<Order>(c(orgId, '/orders'), { contactId, lines: [{ productId: inA.body.productId, quantity: 1 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.items[0].unitPrice).toBe(9);
    const blocked = await owner.post<ApiError>(c(orgId, '/orders'), { contactId, lines: [{ productId: outB.body.productId, quantity: 1 }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details?.code).toBe('not_sellable');

    // Quotes enforce the same answer; anonymous orders are unaffected.
    const qBlocked = await owner.post(c(orgId, '/quotes'), { contactId, lines: [{ productId: outB.body.productId, quantity: 1 }] });
    expect(qBlocked.status).toBe(409);
    const anon = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: outB.body.productId, quantity: 1 }] });
    expect(anon.status).toBe(201);

    // The preview explains.
    const prev = await owner.get<PricePreview>(c(orgId, `/price?productId=${encodeURIComponent(outB.body.productId)}&contactId=${encodeURIComponent(contactId)}`));
    expect(prev.body).toMatchObject({ sellable: false, sellableReason: 'not-in-assortment' });
  });
});

describe('D4 — refunds honesty + shipping capture', () => {
  it('demo intents refund state-only (audited refundProvider none) and shippingAddress is captured', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Ship Me', price: 5, currency: 'USD', inventory: 5 });
    const o = await owner.post<Order>(c(orgId, '/orders'), {
      lines: [{ productId: p.body.productId, quantity: 1 }],
      shippingAddress: { name: 'Dana', line1: '1 Way', city: 'Town', postalCode: '12345', country: 'US' },
    });
    expect(o.body.shippingAddress).toMatchObject({ line1: '1 Way', city: 'Town' });
    await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi_d4' });
    const refunded = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/refund`));
    expect(refunded.status).toBe(200);
    const s = __hostExtStorage();
    const rows = await s!.listAudit({ actionPrefix: 'commerce.order.refunded', limit: 50 });
    const mine = rows.find((r) => r.resource === o.body.orderId);
    expect(at(mine?.payload, 'refundProvider')).toBe('none');
  });
});
