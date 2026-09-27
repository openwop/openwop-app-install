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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { resolveShared } from '../src/features/sharing/sharingService.js';
import { setTransactionalEmailTransport, __resetTransactionalEmail, type TransactionalEmail } from '../src/features/commerce/transactionalEmail.js';

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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
  await new Promise<void>((res) => { merchant.listen(0, '127.0.0.1', () => { MERCHANT_URL = `http://127.0.0.1:${(merchant.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
  __resetTransactionalEmail();
  await new Promise<void>((res) => merchant.close(() => res()));
  await new Promise<void>((res) => server.close(() => res()));
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `pd-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = r.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;
const buyer = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/ucp-buyer${suffix}`;

describe('D1 — order-status share links (the identity floor)', () => {
  it('renders a PII-free markdown status view and the confirmation email carries the link', async () => {
    const { owner, orgId } = await shopOwner();
    const sent: TransactionalEmail[] = [];
    setTransactionalEmailTransport(async (e) => { sent.push(e); return true; });
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Track Me', email: `track-${n++}@x.test` });
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Track Guide', price: 6, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    const paid = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi_d1' });
    expect(paid.status).toBe(200);

    // Confirmation email carries a /shared/ tracking link.
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('https://app.example.test/shared/');

    // The link renders the PII-free status view.
    const token = sent[0].text.split('/shared/')[1].trim();
    const shared = await resolveShared(token);
    expect(shared.resourceType).toBe('commerce_order');
    const md = String(shared.resource.markdown);
    expect(md).toContain('**Status:** paid');
    expect(md).toContain('Track Guide');
    expect(md).not.toContain('track-'); // no email/PII
    __resetTransactionalEmail();
  });
});

describe('D2 — UCP buyer (ADR 0188 floor)', () => {
  it('discovers + searches a merchant, enforces the intent ceiling, the org cap, and the ALWAYS approval; placement is idempotent; tracking reads status', async () => {
    const { owner, orgId, tenantId } = await shopOwner();

    // Discover + search through the egress gate.
    const disco = await owner.post(buyer(orgId, '/discover'), { merchantUrl: MERCHANT_URL });
    expect(disco.status, JSON.stringify(disco.body)).toBe(200);
    expect(disco.body.discovery.ucp).toBe('1.0');
    const cat = await owner.post(buyer(orgId, '/catalog-search'), { merchantUrl: MERCHANT_URL, q: 'widget' });
    expect(cat.body.catalog.products[0].name).toBe('Ext Widget');

    // Intent ceiling: a cart over the authorized max refuses.
    const over = await owner.post(buyer(orgId, '/purchases'), {
      merchantUrl: MERCHANT_URL, intent: 'Buy widgets under $10', maxAmountMinor: 1000, currency: 'USD',
      lines: [{ externalProductId: 'ext-1', name: 'Ext Widget', quantity: 1, unitPriceMinor: 1200 }],
    });
    expect(over.status).toBe(409);

    // Draft within the ceiling.
    const draft = await owner.post(buyer(orgId, '/purchases'), {
      merchantUrl: MERCHANT_URL, intent: 'Buy one widget under $15', maxAmountMinor: 1500, currency: 'USD',
      lines: [{ externalProductId: 'ext-1', name: 'Ext Widget', quantity: 1, unitPriceMinor: 1200 }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const purchaseId: string = draft.body.purchaseId;
    expect(draft.body.cartMandate.totalMinor).toBe(1200);

    // Org cap fail-closed: UNSET ⇒ purchasing disabled.
    delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    const capped = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(capped.status).toBe(403);
    expect(capped.body.details.code).toBe('spend_cap');

    // Cap set → the ALWAYS approval parks.
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000';
    const parked = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(parked.status).toBe(409);
    expect(parked.body.error).toBe('approval_required');
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    expect(appr?.kind).toBe('commerce-spend');
    expect(appr?.amountMinor).toBe(1200);

    // Approve → placed with the merchant; payment mandate carries the honesty warning.
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    const placed = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body.status).toBe('placed');
    expect(placed.body.extOrderId).toMatch(/^ext-ord-/);
    expect(placed.body.paymentMandate.warnings[0]).toContain('ap2_vc_signing_not_configured');

    // Idempotent: a re-checkout never re-posts to the merchant.
    const before = merchantOrders.size;
    const again = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(again.body.status).toBe('placed');
    expect(merchantOrders.size).toBe(before);

    // Tracking reads the merchant's status.
    merchantOrders.get(placed.body.extOrderId)!.status = 'shipped';
    const tracked = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/track`));
    expect(tracked.body.extStatus).toBe('shipped');
  });
});

describe('D3 — account-native assortments', () => {
  it('an exclusive-assortment buyer can order/quote only carried products; anonymous unaffected; the preview says why', async () => {
    const { owner, orgId } = await shopOwner();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Assorted', email: `as-${n++}@x.test` });
    const contactId: string = contact.body.contactId;
    const inA = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Allowed', price: 10, currency: 'USD', inventory: 10 });
    const outB = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Forbidden', price: 10, currency: 'USD', inventory: 10 });
    await owner.post(c(orgId, '/price-lists'), { name: 'Contract A', currency: 'USD', priority: 1, contactIds: [contactId], exclusiveAssortment: true, entries: [{ productId: inA.body.productId, price: 9 }] });

    // In-assortment order succeeds at the contract price; out-of-assortment 409s.
    const ok = await owner.post(c(orgId, '/orders'), { contactId, lines: [{ productId: inA.body.productId, quantity: 1 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.items[0].unitPrice).toBe(9);
    const blocked = await owner.post(c(orgId, '/orders'), { contactId, lines: [{ productId: outB.body.productId, quantity: 1 }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.code).toBe('not_sellable');

    // Quotes enforce the same answer; anonymous orders are unaffected.
    const qBlocked = await owner.post(c(orgId, '/quotes'), { contactId, lines: [{ productId: outB.body.productId, quantity: 1 }] });
    expect(qBlocked.status).toBe(409);
    const anon = await owner.post(c(orgId, '/orders'), { lines: [{ productId: outB.body.productId, quantity: 1 }] });
    expect(anon.status).toBe(201);

    // The preview explains.
    const prev = await owner.get(c(orgId, `/price?productId=${encodeURIComponent(outB.body.productId)}&contactId=${encodeURIComponent(contactId)}`));
    expect(prev.body).toMatchObject({ sellable: false, sellableReason: 'not-in-assortment' });
  });
});

describe('D4 — refunds honesty + shipping capture', () => {
  it('demo intents refund state-only (audited refundProvider none) and shippingAddress is captured', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Ship Me', price: 5, currency: 'USD', inventory: 5 });
    const o = await owner.post(c(orgId, '/orders'), {
      lines: [{ productId: p.body.productId, quantity: 1 }],
      shippingAddress: { name: 'Dana', line1: '1 Way', city: 'Town', postalCode: '12345', country: 'US' },
    });
    expect(o.body.shippingAddress).toMatchObject({ line1: '1 Way', city: 'Town' });
    await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi_d4' });
    const refunded = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/refund`));
    expect(refunded.status).toBe(200);
    const s = __hostExtStorage();
    const rows = await s!.listAudit({ actionPrefix: 'commerce.order.refunded', limit: 50 });
    const mine = rows.find((r) => r.resource === o.body.orderId);
    expect((mine?.payload as { refundProvider?: string }).refundProvider).toBe('none');
  });
});
