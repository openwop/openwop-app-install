/**
 * Commerce governance wiring (ADR 0221 / ecommerce gap plan §5B Phase B) — proves:
 *  - B1 audit rows: product/order/coupon mutations land `commerce.*` rows in the
 *    ONE audit store with `payload.tenantId` stamped (the governance-view contract);
 *  - B2 host events: `host.commerce.order.paid` fans out to a webhook subscriber
 *    (emitHostEvent — ADR 0208), and low-stock fires once per threshold crossing;
 *  - B3 spend gates: refunds at/over `commerce.refundApprovalThresholdMinor` park a
 *    `commerce-spend` approval (409 approval_required), approved → retry proceeds,
 *    rejected → stays blocked; agent-path order creation honors the order threshold
 *    while operator REST creation does not;
 *  - B5 surface verbs: refund/fulfillment/coupons/inventory over ctx.features.commerce;
 *  - B6 CRM linkage: paying an order with a contact appends a deterministic-id
 *    Activity to the contact's timeline (idempotent under re-delivery).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { getSetCookies } from './headerCookies.js';
import type { Product, Order } from '../src/features/commerce/commerceService.js';
import type { Contact } from '../src/features/crm/contactsService.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { buildCommerceSurface } from '../src/features/commerce/surface.js';
import { listActivities } from '../src/features/crm/crmEntitiesService.js';
import type { Storage } from '../src/storage/storage.js';
import { bareRunId } from './support/bareRunId.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}

let BASE: string; let server: http.Server; let app: Express; let storage: Storage; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage; // `app.locals` is untyped (Express); the declared `Storage` is the statement
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Read one field of an untyped value (an audit payload, a surface verb's result)
 *  without a cast: anything that is not an object along the path reads `undefined`. */
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
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T = unknown>(p: string) => call<T>('DELETE', p) };
}
/** The body is EITHER the success shape OR the error envelope — every field of both optional. */
type OrError<T> = Partial<T> & Partial<ApiError>;
interface LoginBody { user?: { userId: string; tenantId?: string }; tenantId?: string }

async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `cgov-${Date.now()}-${n++}@acme.test` });
  expect(r.status).toBe(201);
  const tenantId: string = r.body.tenantId ?? r.body.user?.tenantId ?? '';
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Shop' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

const c = (orgId: string, suffix = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

function storageOrThrow(): Storage {
  const s = __hostExtStorage();
  if (!s) throw new Error('host-ext storage not initialized');
  return s;
}

async function productAndPaidOrder(owner: ReturnType<typeof client>, orgId: string, price: number, extra: Record<string, unknown> = {}): Promise<{ productId: string; orderId: string }> {
  const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: `Gadget ${n++}`, price, currency: 'USD', inventory: 50, ...extra });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const paid = await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: `demo:pi_${n}` });
  expect(paid.status).toBe(200);
  return { productId: p.body.productId, orderId: o.body.orderId };
}

describe('B1 — audit rows across the lifecycle', () => {
  it('lands commerce.* rows with payload.tenantId for product/order mutations', async () => {
    const { owner, orgId } = await shopOwner();
    const { orderId } = await productAndPaidOrder(owner, orgId, 12);
    const rows = await storageOrThrow().listAudit({ actionPrefix: 'commerce.', limit: 300 });
    const mine = rows.filter((r) => at(r.payload, 'orgId') === orgId);
    const actions = mine.map((r) => r.action);
    expect(actions).toContain('commerce.product.created');
    expect(actions).toContain('commerce.order.created');
    expect(actions).toContain('commerce.order.paid');
    for (const r of mine) expect(at(r.payload, 'tenantId')).toBeTruthy();
    const paidRow = mine.find((r) => r.action === 'commerce.order.paid');
    expect(paidRow?.resource).toBe(orderId);
    expect(at(paidRow?.payload, 'paymentVerification')).toBe('none');
  });
});

describe('B2 — host events (emitHostEvent, ADR 0208)', () => {
  it('enqueues a webhook delivery for host.commerce.order.paid', async () => {
    const { owner, orgId } = await shopOwner();
    const sub = await owner.post<{ webhookId: string }>('/webhooks', { url: 'https://example.com/openwop-test/commerce-events', events: ['host.commerce.order.paid'] });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    try {
      await productAndPaidOrder(owner, orgId, 9);
      // Poll the real condition (the delivery is enqueued fire-and-forget), never
      // a fixed sleep budget that reads as "absent" when the box is slow.
      let i = 0;
      await vi.waitFor(async () => {
        const claimed = await storage.claimDueWebhookDeliveries(`cgov-worker-${i++}`, Date.now() + 1, 5000, 20);
        expect(claimed.some((d) => d.subscriptionId === bareRunId(sub.body.webhookId) && d.eventType === 'openwop-app.commerce.order-paid')).toBe(true);
      }, { timeout: 3000, interval: 25 });
    } finally {
      await owner.del(`/webhooks/${sub.body.webhookId}`);
    }
  });

  it('fires low-stock once per downward crossing (audit-row proof)', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Scarce', price: 5, currency: 'USD', inventory: 3, lowStockThreshold: 3 });
    const buyAndPay = async (): Promise<void> => {
      const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
      const paid = await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: `demo:pi_ls_${n++}` });
      expect(paid.status).toBe(200);
    };
    await buyAndPay(); // 3 → 2: crosses below threshold(3) → fires
    await buyAndPay(); // 2 → 1: already below → must NOT fire again
    const rows = await storageOrThrow().listAudit({ actionPrefix: 'commerce.inventory.low-stock', limit: 100 });
    const mine = rows.filter((r) => at(r.payload, 'productId') === p.body.productId);
    expect(mine).toHaveLength(1);
    expect(at(mine[0]?.payload, 'inventory')).toBe(2);
  });
});

describe('B3 — refund threshold gate (every caller)', () => {
  it('below threshold refunds pass; at/over parks a commerce-spend approval; approve → retry succeeds; reject → blocked', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { refundApprovalThresholdMinor: 2_000 } }, 'test'); // $20.00
    try {

      // Below threshold: frictionless.
      const small = await productAndPaidOrder(owner, orgId, 10);
      const r1 = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(small.orderId)}/refund`));
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(r1.body.status).toBe('refunded');

      // At/over: parked. NOTE the envelope's entropy scrub (DATA-6 /
      // secret-leakage-error-envelope) redacts the raw approvalId on the wire BY
      // DESIGN — callers key off `approvalStatus` + the reviews inbox; tests
      // correlate via the deterministic spendIdemKey.
      const big = await productAndPaidOrder(owner, orgId, 25);
      const r2 = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(big.orderId)}/refund`));
      expect(r2.status).toBe(409);
      expect(r2.body.error).toBe('approval_required'); // canonical envelope: error = code string
      expect(r2.body.details?.approvalStatus).toBe('pending');
      const gateKey = `commerce-refund:${big.orderId}`;
      const findByKey = async (status: 'pending' | 'approved' | 'rejected') =>
        (await listApprovals(tenantId, status)).find((a) => a.spendIdemKey === gateKey);
      const appr = await findByKey('pending');
      expect(appr?.kind).toBe('commerce-spend');
      expect(appr?.spendKind).toBe('refund');
      expect(appr?.amountMinor).toBe(2_500);

      // Retry while pending → same approval, not a duplicate.
      const r3 = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(big.orderId)}/refund`));
      expect(r3.status).toBe(409);
      expect((await listApprovals(tenantId, 'pending')).filter((a) => a.spendIdemKey === gateKey)).toHaveLength(1);

      // Approve → the retried refund proceeds.
      expect((await resolveApproval(appr!.approvalId, { status: 'approved' }))?.changed).toBe(true);
      const r4 = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(big.orderId)}/refund`));
      expect(r4.status, JSON.stringify(r4.body)).toBe(200);
      expect(r4.body.status).toBe('refunded');

      // Rejected: a different order stays blocked.
      const blocked = await productAndPaidOrder(owner, orgId, 30);
      const r5 = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(blocked.orderId)}/refund`));
      expect(r5.status).toBe(409);
      const rejected = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `commerce-refund:${blocked.orderId}`);
      await resolveApproval(rejected!.approvalId, { status: 'rejected' });
      const r6 = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(blocked.orderId)}/refund`));
      expect(r6.status).toBe(409);
      expect(r6.body.details?.approvalStatus).toBe('rejected');
    } finally {
      await setGovernancePolicy(tenantId, { commerce: {} }, 'test');
    }
  });

  it('order threshold gates the AGENT path (surface) but never operator REST data-entry', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { orderApprovalThresholdMinor: 5_000 } }, 'test'); // $50
    try {

      const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Big Ticket', price: 80, currency: 'USD', inventory: 10 });
      expect(p.status).toBe(201);

      // Operator REST create: ungated.
      const rest = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
      expect(rest.status, JSON.stringify(rest.body)).toBe(201);

      // Agent path (ctx.features.commerce): parked.
      const surface = buildCommerceSurface({ tenantId });
      await expect(surface.createOrder({ orgId, lines: [{ productId: p.body.productId, quantity: 1 }] }))
        .rejects.toMatchObject({ code: 'approval_required' });
      // ONE approval authorizes exactly ONE order: approve → create succeeds → an
      // identical agent order re-parks a FRESH approval (the consume-on-create rule —
      // ads can lean on its dispatch dedup ledger; orders cannot).
      const parked = (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'commerce-spend' && a.spendKind === 'order');
      expect(parked).toBeTruthy();
      await resolveApproval(parked!.approvalId, { status: 'approved' });
      const approvedOrder = await surface.createOrder({ orgId, lines: [{ productId: p.body.productId, quantity: 1 }] });
      expect(at(approvedOrder, 'order', 'orderId')).toEqual(expect.any(String));
      await expect(surface.createOrder({ orgId, lines: [{ productId: p.body.productId, quantity: 1 }] }))
        .rejects.toMatchObject({ code: 'approval_required' });
      // ...and below-threshold agent orders pass.
      const cheap = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Small Ticket', price: 3, currency: 'USD', inventory: 10 });
      const ok = await surface.createOrder({ orgId, lines: [{ productId: cheap.body.productId, quantity: 1 }] });
      expect(at(ok, 'order', 'orderId')).toEqual(expect.any(String));
    } finally {
      await setGovernancePolicy(tenantId, { commerce: {} }, 'test');
    }
  });
});

describe('B5 — surface order-ops verbs', () => {
  it('fulfillment + coupons + inventory flow through ctx.features.commerce', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const surface = buildCommerceSurface({ tenantId });
    const { productId, orderId } = await productAndPaidOrder(owner, orgId, 7);

    const shipped = await surface.updateFulfillment({ orgId, orderId, fulfillmentStatus: 'shipped' });
    expect(at(shipped, 'order', 'fulfillmentStatus')).toBe('shipped');
    const delivered = await surface.updateFulfillment({ orgId, orderId, fulfillmentStatus: 'delivered' });
    expect(at(delivered, 'order', 'status')).toBe('fulfilled');

    const coupon = await surface.createCoupon({ orgId, code: 'agent10', type: 'percentage', value: 10 });
    expect(at(coupon, 'coupon', 'code')).toBe('AGENT10');
    const coupons = await surface.listCoupons({ orgId });
    expect(at(coupons, 'coupons')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AGENT10' })]));

    const inv = await surface.adjustInventory({ orgId, productId, inventory: 42 });
    expect(at(inv, 'product', 'inventory')).toBe(42);

    const got = await surface.getOrder({ orgId, orderId });
    expect(at(got, 'order', 'orderId')).toBe(orderId);
    const listed = await surface.listOrders({ orgId });
    expect(at(listed, 'orders')).toEqual(expect.arrayContaining([expect.objectContaining({ orderId })]));
    // …and the verbs' writes landed in storage, not only in their return values.
    const reread = await surface.getOrder({ orgId, orderId });
    expect(at(reread, 'order')).toMatchObject({ fulfillmentStatus: 'delivered', status: 'fulfilled' });
  });
});

describe('B6 — order↔CRM Activity linkage', () => {
  it('paying an order with a contact appends ONE deterministic-id activity', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Buyer Bea', email: 'bea@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId: string = contact.body.contactId;

    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 4, currency: 'USD' });
    const o = await owner.post<Order>(c(orgId, '/orders'), { contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const paid = await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi_b6' });
    expect(paid.status).toBe(200);

    const acts = await listActivities(tenantId, orgId, { contactId });
    const orderActs = acts.filter((a) => a.activityId === `act:commerce-order-${String(o.body.orderId).replace(/^ord:/, '')}`);
    expect(orderActs).toHaveLength(1);
    expect(orderActs[0].body).toContain(o.body.orderId);
    expect(orderActs[0].createdBy).toBe('system:commerce');
  });
});
