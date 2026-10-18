/**
 * grade-code hardening pass — concurrency, webhook money-truth, and UCP-buyer
 * gates that the phase suites asserted only serially:
 *  - B3 refund double-submit is CAS-guarded (exactly one refund);
 *  - B4 pay-vs-cancel race can't cancel a paid order;
 *  - B2 the service refuses to flip a CANCELED order paid;
 *  - I3 the spend gate fails CLOSED on a policy-read error;
 *  - B8 the UCP org cap holds under two concurrent different purchases;
 *  - B9 a merchant timeout stamps 'unknown' (no blind re-checkout).
 *
 * Every race is FORCED: the competing call runs inside the first call's window
 * (a one-shot hook on the storage CAS or on a dependency the first call awaits
 * between its read and its swap). Two `Promise.all` HTTP calls almost never
 * interleave on one event loop — measured: the CAS sabotages stayed green that way.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import type { Product, Order } from '../src/features/commerce/commerceService.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import * as governance from '../src/host/governanceService.js';
import * as approvalService from '../src/host/approvalService.js';
import { checkoutPurchase, type UcpPurchase } from '../src/features/commerce/ucpBuyer/ucpBuyerService.js';
import { markAsPaid, cancelOrder, getOrder, refundOrder, getProduct } from '../src/features/commerce/commerceService.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}

let BASE: string; let server: http.Server; let n = 0;
let merchant: http.Server; let MERCHANT_URL = ''; let merchantMode: 'ok' | 'hang' = 'ok';
const merchantHits = { checkout: 0 };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS = '600'; // short abort so the hang test is fast
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'commerce-ucp-buyer', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  merchant = http.createServer((req, res) => {
    const j = (code: number, b: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if ((req.url ?? '') === '/checkout' && req.method === 'POST') {
      merchantHits.checkout += 1;
      if (merchantMode === 'hang') return; // never respond → client abort
      return j(201, { orderId: `ext-${merchantHits.checkout}` });
    }
    return j(404, {});
  });
  await new Promise<void>((res) => { merchant.listen(0, '127.0.0.1', () => { MERCHANT_URL = `http://127.0.0.1:${portOf(merchant)}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR; delete process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS;
  await new Promise<void>((res) => merchant.close(() => res()));
  await new Promise<void>((res) => server.close(() => res()));
});

/** Read one field of an untyped value (a raw storage row) without a cast. */
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
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
/** The body is EITHER the success shape OR the error envelope — every field of both optional. */
type OrError<T> = Partial<T> & Partial<ApiError>;
interface LoginBody { user?: { userId: string; tenantId?: string }; tenantId?: string }
async function shop(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `hd-${Date.now()}-${n++}@x.test` });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '' };
}
const c = (o: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(o)}${s}`;
async function paidOrder(owner: ReturnType<typeof client>, orgId: string, price = 10): Promise<string> {
  const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: `P${n++}`, price, currency: 'USD', inventory: 20 });
  const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
  await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: `demo:pi_${n++}` });
  return o.body.orderId;
}

describe('B3/B4 — order status transitions are CAS-guarded', () => {
  it('a second refund landing inside the first one\'s window does not refund twice (one audit row, stock restored once)', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: `R${n++}`, price: 10, currency: 'USD', inventory: 20 });
    const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    const orderId: string = o.body.orderId;
    await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(orderId)}/pay`), { paymentIntentId: `demo:pi_${n++}` });
    // The first refund reads the order (`paid`), then awaits the spend-gate policy
    // read BEFORE its paid→refunding claim. The second refund runs to completion
    // inside that await, so the first one's claim must lose.
    const realPolicy = governance.getGovernancePolicy;
    let fired = false;
    const spy = vi.spyOn(governance, 'getGovernancePolicy').mockImplementation(async (t) => {
      if (!fired) { fired = true; await refundOrder(tenantId, orgId, orderId, { actor: 'inner' }); }
      return realPolicy(t);
    });
    let outer: Awaited<ReturnType<typeof refundOrder>>;
    try {
      outer = await refundOrder(tenantId, orgId, orderId, { actor: 'outer' });
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);
    expect(outer?.status).toBe('refunded'); // the loser answers idempotently
    const rows = await __hostExtStorage()!.listAudit({ actionPrefix: 'commerce.order.refunded', limit: 50 });
    expect(rows.filter((x) => x.resource === orderId)).toHaveLength(1); // exactly one refund
    expect((await getProduct(tenantId, orgId, p.body.productId))?.inventory).toBe(20); // 20 → 19 reserved → +1 once
  });

  it('pay wins a pay-vs-cancel race — a paid order is never canceled + stock never wrongly restored', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Race', price: 5, currency: 'USD', inventory: 3 });
    const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    const orderId: string = o.body.orderId;
    // Cancel reads `pending`; PAY completes inside cancel's pending→canceled swap
    // window. Cancel's CAS must then lose (its expected row is gone) and return
    // the paid row — never overwrite it to `canceled` and restore sold stock.
    const storage = __hostExtStorage()!;
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let fired = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!fired && key.includes(orderId) && at(JSON.parse(next), 'status') === 'canceled') {
        fired = true;
        await markAsPaid(tenantId, orgId, orderId, `demo:pi_race_${n++}`);
      }
      return realCas(key, expected, next);
    });
    let canceled: Awaited<ReturnType<typeof cancelOrder>>;
    try {
      canceled = await cancelOrder(tenantId, orgId, orderId);
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);
    expect(canceled?.status).toBe('paid'); // lost the CAS → returns the current row
    expect((await getOrder(tenantId, orgId, orderId))?.status).toBe('paid');
    const prod = await owner.get<Product>(c(orgId, `/products/${encodeURIComponent(p.body.productId)}`));
    expect(prod.body.inventory).toBe(2); // the sold unit stays sold
  });
});

describe('B2 — webhook money-truth', () => {
  it('a payment that lands on a canceled order is REFUSED by the service, never flipped paid', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Late', price: 7, currency: 'USD', inventory: 5 });
    const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    await cancelOrder(tenantId, orgId, o.body.orderId); // order gone before the webhook
    // Drive markAsPaid the way the webhook does (keyless demo) → it 409s (canceled).
    await expect(markAsPaid(tenantId, orgId, o.body.orderId, 'pi_late', { actor: 'stripe-webhook' }))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringMatching(/Only a pending order can be marked paid \(is 'canceled'\)/) });
    // (The webhook route's audit of that refusal is a route claim, not asserted here.)
    const fresh = await getOrder(tenantId, orgId, o.body.orderId);
    expect(fresh?.status).toBe('canceled');
  });
});

describe('I3 — spend gate fails closed on a policy read error', () => {
  it('a refund is HELD (503) when the governance policy read throws', async () => {
    const { owner, orgId } = await shop();
    const orderId = await paidOrder(owner, orgId, 12);
    const spy = vi.spyOn(governance, 'getGovernancePolicy').mockRejectedValueOnce(new Error('storage down'));
    try {
      const r = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(orderId)}/refund`));
      expect(r.status).toBe(503);
      expect(r.body.message).toMatch(/spend-approval policy could not be read/);
    } finally {
      spy.mockRestore();
    }
    // With the read healthy again, the refund proceeds.
    const ok = await owner.post<OrError<Order>>(c(orgId, `/orders/${encodeURIComponent(orderId)}/refund`));
    expect(ok.status).toBe(200);
  });
});

describe('B8/B9 — UCP buyer cap + timeout', () => {
  const buy = (o: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(o)}/ucp-buyer${s}`;
  async function approvedDraft(owner: ReturnType<typeof client>, orgId: string, tenantId: string, unitMinor: number): Promise<string> {
    const d = await owner.post<UcpPurchase>(buy(orgId, '/purchases'), { merchantUrl: MERCHANT_URL, intent: 'buy', maxAmountMinor: unitMinor * 2, currency: 'USD', lines: [{ externalProductId: 'x', name: 'X', quantity: 1, unitPriceMinor: unitMinor }] });
    const pid: string = d.body.purchaseId;
    await owner.post(buy(orgId, `/purchases/${encodeURIComponent(pid)}/checkout`)); // parks approval
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${pid}`);
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    return pid;
  }
  it('the org cap holds when a second approved purchase places inside the first one\'s window', async () => {
    const { owner, orgId, tenantId } = await shop();
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '1500'; // room for ONE 1000-minor purchase
    merchantMode = 'ok';
    try {
      const a = await approvedDraft(owner, orgId, tenantId, 1000);
      const b = await approvedDraft(owner, orgId, tenantId, 1000);
      // A passes its PRE-check (nothing committed yet), then awaits its approval
      // read; B places to completion inside that await. A's AUTHORITATIVE post-CAS
      // re-count must then see B and refuse.
      const realGet = approvalService.getApproval;
      let fired = false;
      let inner: Awaited<ReturnType<typeof checkoutPurchase>> | undefined;
      const spy = vi.spyOn(approvalService, 'getApproval').mockImplementation(async (id) => {
        if (!fired) { fired = true; inner = await checkoutPurchase(tenantId, orgId, b); }
        return realGet(id);
      });
      try {
        await expect(checkoutPurchase(tenantId, orgId, a))
          .rejects.toMatchObject({ httpStatus: 403, details: { code: 'spend_cap' } });
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      expect(inner?.status).toBe('placed');
      const got = await owner.get<UcpPurchase>(buy(orgId, `/purchases/${encodeURIComponent(a)}`));
      expect(got.body.status).not.toBe('placed');
      expect(merchantHits.checkout).toBeGreaterThan(0);
    } finally {
      delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    }
  });
  it('a merchant timeout stamps the purchase unknown and blocks a blind re-checkout', async () => {
    const { owner, orgId, tenantId } = await shop();
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000';
    merchantMode = 'hang';
    try {
      const pid = await approvedDraft(owner, orgId, tenantId, 500);
      const r = await owner.post(buy(orgId, `/purchases/${encodeURIComponent(pid)}/checkout`));
      expect(r.status).toBe(502);
      const got = await owner.get<UcpPurchase>(buy(orgId, `/purchases/${encodeURIComponent(pid)}`));
      expect(got.body.status).toBe('unknown');
      merchantMode = 'ok';
      const hitsBefore = merchantHits.checkout;
      const retry = await owner.post<ApiError>(buy(orgId, `/purchases/${encodeURIComponent(pid)}/checkout`));
      // unknown ⇒ must reconcile, no blind retry. The MESSAGE is asserted: the
      // generic "Purchase is 'unknown'" status guard also answers 409 with
      // details.status 'unknown', so the code alone cannot see the dedicated block.
      expect(retry.status).toBe(409);
      expect(retry.body.message).toMatch(/could not be confirmed/);
      expect(merchantHits.checkout).toBe(hitsBefore); // nothing re-posted to the merchant
    } finally {
      merchantMode = 'ok';
      delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    }
  });
});
