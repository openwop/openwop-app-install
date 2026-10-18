/**
 * ADR 0875 — commerce trust boundaries on a LIVE host (a Stripe key resolves).
 *
 * Every case here was written RED against `origin/main` @ `f7a216b78` before the
 * fix, and each names the finding it pins. A mock Stripe HTTP server stands in
 * for the platform account (the `commerce-one-click` precedent): it records every
 * call and echoes each intent's OWN amount/currency/metadata on the verification
 * read, so a foreign intent is distinguishable from the order's own.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { getOrder, markAsPaid, captureSavedPmFromPaidIntent, createOrder, listOrders } from '../src/features/commerce/commerceService.js';

let BASE: string; let server: http.Server; let stripe: http.Server; let n = 0;
interface StripeCall { method: string; path: string; form: URLSearchParams }
const calls: StripeCall[] = [];
interface Intent { amount: number; currency: string; status: string; metadata: Record<string, string> }
const intents = new Map<string, Intent>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      // Stripe's API-version prefix is stripped so the assertions below name the
      // resource alone (and this file is not counted as OpenWOP v1 reliance).
      const url = (req.url ?? '').replace(/^\/v\d+/, '');
      calls.push({ method: req.method ?? '', path: url, form });
      const reply = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const meta = (prefix: string): Record<string, string> => {
        const m: Record<string, string> = {};
        for (const k of ['orderId', 'tenantId', 'orgId']) { const v = form.get(`${prefix}[${k}]`); if (v) m[k] = v; }
        return m;
      };
      if (req.method === 'POST' && url === '/payment_intents') {
        const id = `pi_oc_${calls.length}`;
        intents.set(id, { amount: Number(form.get('amount') ?? 0), currency: String(form.get('currency') ?? 'usd'), status: 'succeeded', metadata: meta('metadata') });
        reply(200, { id, status: 'succeeded' });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/payment_intents/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        const known = intents.get(id);
        if (!known) { reply(404, { error: { message: 'No such payment_intent' } }); return; }
        reply(200, { id, ...known });
        return;
      }
      if (url === '/checkout/sessions') { reply(200, { id: `cs_${calls.length}`, url: 'https://checkout.stripe.test/s' }); return; }
      if (url === '/customers') { reply(200, { id: `cus_${calls.length}` }); return; }
      if (url === '/refunds') { reply(200, { id: `re_${calls.length}`, status: 'succeeded' }); return; }
      reply(200, { id: `obj_${calls.length}`, status: 'active' });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm', 'commerce-ucp']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await setSecret('billing:stripe-key', 'sk_test_mock');
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS; // ADR 0877 — set per shop above
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});

/** The JSON fields these cases read. Declared, not `any`: a field the server does
 *  not send fails the assertion that reads it, and a typo fails `tsc`. */
interface WireBody {
  productId: string; orgId: string; orderId: string; contactId: string; clientId: string; clientSecret: string; access_token: string;
  quoteId: string; total: number; mode?: string; error?: string; message?: string; details?: { code?: string };
  subscription: { subscriptionId: string };
}
interface Res<T = WireBody> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, bearer?: string): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // The fetch boundary is the one place JSON enters untyped; an empty body reads as {}.
    const out: WireBody = res.status === 204 ? JSON.parse('{}') : await res.json().catch(() => JSON.parse('{}'));
    return { status: res.status, body: out };
  };
  return {
    get: (p: string, bearer?: string) => call('GET', p, undefined, bearer),
    post: (p: string, b?: unknown, bearer?: string) => call('POST', p, b, bearer),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
  };
}
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;
const pub = (orgId: string, s = ''): string => `/host/openwop-app/public-store/${encodeURIComponent(orgId)}${s}`;
const ucp = (orgId: string, s = ''): string => `/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}${s}`;

async function shop(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const tenantId = `org:a0875-${Date.now()}-${n++}`;
  const login = await owner.post('/host/openwop-app/test/login', { email: `a0875-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  // ADR 0877 — these cases exercise the PLATFORM settlement lane, which only an
  // operator (superadmin / OPENWOP_COMMERCE_PLATFORM_TENANTS) tenant may use since ADR 0877.
  process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS = [process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS, tenantId].filter(Boolean).join(',');
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Trust Shop' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

/** The success URL the public checkout handed Stripe for `orderId`. */
function successUrlFor(orderId: string): URL {
  const call = [...calls].reverse().find((x) => x.path === '/checkout/sessions' && x.form.get('metadata[orderId]') === orderId);
  expect(call, `no checkout session for ${orderId}`).toBeDefined();
  return new URL(String(call!.form.get('success_url')));
}

/** A guest buys `productId`, Stripe settles it the way the webhook would. */
async function paidGuestOrder(orgId: string, tenantId: string, productId: string, email: string, save: boolean): Promise<{ orderId: string; oc: string | null }> {
  const guest = client();
  const co = await guest.post(pub(orgId, '/checkout'), { email, lines: [{ productId, quantity: 1 }], savePaymentMethod: save });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const orderId: string = co.body.orderId;
  const order = await getOrder(tenantId, orgId, orderId);
  const pi = `pi_parent_${n++}`;
  intents.set(pi, { amount: Math.round((order!.total + (order!.taxTotal ?? 0) + (order!.shippingCost ?? 0)) * 100), currency: 'usd', status: 'succeeded', metadata: { orderId, tenantId, orgId } });
  await markAsPaid(tenantId, orgId, orderId, pi, { actor: 'test', stripeKey: 'sk_test_mock' });
  const paid = await getOrder(tenantId, orgId, orderId);
  if (save) expect(await captureSavedPmFromPaidIntent(paid!, { customer: `cus_${email}`, payment_method: `pm_${email}` })).toBe(true);
  return { orderId, oc: successUrlFor(orderId).searchParams.get('oc') };
}

describe('ADR 0875 D1 — a public guest is priced as anonymous', () => {
  it('typing a contract customer\'s email does not buy at the contract price', async () => {
    const { owner, orgId } = await shop();
    const email = `contract-${n++}@buyer.test`;
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'Contract Buyer', email });
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Licence', price: 100, currency: 'USD' });
    await owner.post(c(orgId, '/price-lists'), { name: 'Contract', currency: 'USD', priority: 5, contactIds: [contact.body.contactId], entries: [{ productId: p.body.productId, price: 10 }] });
    // The contract still applies on the authenticated operator lane …
    const op = await owner.post(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(op.body.total).toBe(10);
    // … but not to an anonymous caller who merely typed the email (RED on main: 10).
    const co = await client().post(pub(orgId, '/checkout'), { email, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.total).toBe(100);
  });
});

describe('ADR 0875 D2 — one-click needs a capability bound to the order it saved from', () => {
  it('refuses a call without the success-URL token, and honours one with it', async () => {
    const { owner, orgId, tenantId } = await shop();
    const main = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
    const up = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Coaching', price: 50, currency: 'USD' });
    const { orderId, oc } = await paidGuestOrder(orgId, tenantId, main.body.productId, `buyer-${n++}@x.test`, true);
    expect(oc, 'the success URL carries the one-click capability').toBeTruthy();
    const anon = client();
    // No token / a wrong token ⇒ the uniform 404 (RED on main: 201 + a charge).
    for (const body of [{ productId: up.body.productId }, { productId: up.body.productId, oc: `${oc}x` }]) {
      const r = await anon.post(pub(orgId, `/orders/${encodeURIComponent(orderId)}/one-click`), body);
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body).toMatchObject({ error: 'not_found', message: 'Order not found.' });
    }
    const ok = await anon.post(pub(orgId, `/orders/${encodeURIComponent(orderId)}/one-click`), { productId: up.body.productId, oc });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('an attacker who checks out with the victim\'s email cannot charge the victim\'s saved card (architect B1)', async () => {
    const { owner, orgId, tenantId } = await shop();
    const main = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
    const cheap = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Sticker', price: 1, currency: 'USD' });
    const up = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Coaching', price: 50, currency: 'USD' });
    const victim = `victim-${n++}@x.test`;
    await paidGuestOrder(orgId, tenantId, main.body.productId, victim, true); // the victim saves a card
    // The attacker buys a sticker with the victim's email, pays with their own card, no save.
    const attack = await paidGuestOrder(orgId, tenantId, cheap.body.productId, victim, false);
    const before = calls.filter((x) => x.path === '/payment_intents').length;
    const r = await client().post(pub(orgId, `/orders/${encodeURIComponent(attack.orderId)}/one-click`), { productId: up.body.productId, oc: attack.oc });
    expect(r.status, JSON.stringify(r.body)).toBe(400); // no saved method for THIS order
    expect(calls.filter((x) => x.path === '/payment_intents').length, 'no off-session charge was attempted').toBe(before);
  });

  it('caps the one-click quantity', async () => {
    const { owner, orgId, tenantId } = await shop();
    const main = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
    const up = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Seat', price: 5, currency: 'USD' });
    const { orderId, oc } = await paidGuestOrder(orgId, tenantId, main.body.productId, `q-${n++}@x.test`, true);
    const r = await client().post(pub(orgId, `/orders/${encodeURIComponent(orderId)}/one-click`), { productId: up.body.productId, quantity: 1000, oc });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('quantity must be a whole number from 1 to 10.');
  });
});

describe('ADR 0875 D3 — an intent must belong to the order it pays and refunds', () => {
  it('refuses to mark an order paid with another order\'s succeeded intent', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    // A real, succeeded, same-amount intent that belongs to SOMEONE ELSE's order.
    intents.set('pi_foreign', { amount: 4000, currency: 'usd', status: 'succeeded', metadata: { orderId: 'ord:other', tenantId: 'org:other', orgId: 'org:other' } });
    const r = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'pi_foreign' });
    expect(r.status, JSON.stringify(r.body)).toBe(409); // RED on main: 200 paid
    expect(r.body.details?.code).toBe('payment_intent_mismatch'); // not the amount/currency 409s
    expect((await getOrder(tenantId, orgId, o.body.orderId))?.status).toBe('pending');
    // The order's own bound intent still pays it.
    intents.set('pi_own', { amount: 4000, currency: 'usd', status: 'succeeded', metadata: { orderId: o.body.orderId, tenantId, orgId } });
    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'pi_own' })).status).toBe(200);
  });

  it('refuses to send a Stripe refund for a stored intent the order does not own (architect H3)', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    // A pre-0875 row: paid on a keyless lane with a foreign `pi_` id stored.
    intents.set('pi_someone_else', { amount: 4000, currency: 'usd', status: 'succeeded', metadata: { orderId: 'ord:x', tenantId: 'org:x', orgId: 'org:x' } });
    await markAsPaid(tenantId, orgId, o.body.orderId, 'pi_someone_else', {});
    const before = calls.filter((x) => x.path === '/refunds').length;
    const full = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/refund`));
    expect(full.status, JSON.stringify(full.body)).toBe(409);
    expect(full.body.details?.code).toBe('payment_intent_unbound');
    const part = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/partial-refund`), { amount: 5, refundKey: 'k1' });
    expect(part.status, JSON.stringify(part.body)).toBe(409);
    expect(part.body.details?.code).toBe('payment_intent_unbound');
    expect(calls.filter((x) => x.path === '/refunds').length, 'no refund reached Stripe').toBe(before);
    expect((await getOrder(tenantId, orgId, o.body.orderId))?.status, 'refused BEFORE any claim — nothing wedged').toBe('paid');
  });
});

describe('ADR 0875 D4 — UCP does not settle unverified payments on a live host', () => {
  it('/pay and /checkout refuse with live_payment_required', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const prov = await owner.post(c(orgId, '/ucp/clients'), { name: 'agent' });
    expect(prov.status, JSON.stringify(prov.body)).toBe(201);
    const tok = await client().post(ucp(orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    const bearer: string = tok.body.access_token;
    await client().post(ucp(orgId, '/cart/items'), { item_id: p.body.productId, quantity: 1 }, bearer);
    const co = await client().post(ucp(orgId, '/checkout'), {}, bearer);
    expect(co.status, JSON.stringify(co.body)).toBe(409);
    expect(co.body.details?.code ?? co.body.error).toMatch(/live_payment_required/);
    // An existing pending order cannot be settled by an unverified mandate either. It
    // must be THIS client's own order (`createdBy` = its subject, what UCP checkout
    // stamps): an order anyone else created is refused 404 by the D4 ownership check
    // first, so it could never reach the live-payment refusal.
    const own = await createOrder({ tenantId, orgId, createdBy: `ucp:${prov.body.clientId}`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    const pay = await client().post(ucp(orgId, `/orders/${encodeURIComponent(own.orderId)}/pay`), { ap2_mandate: { amount: 40, currency: 'USD' } }, bearer);
    expect(pay.status, JSON.stringify(pay.body)).toBe(409);
    expect(pay.body.details?.code).toBe('live_payment_required');
    expect((await getOrder(tenantId, orgId, own.orderId))?.status).toBe('pending'); // RED on main: paid
    // Control: an order the client did NOT create is the ownership 404, a separate gate.
    const human = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect((await client().post(ucp(orgId, `/orders/${encodeURIComponent(human.body.orderId)}/pay`), { ap2_mandate: { amount: 40, currency: 'USD' } }, bearer)).status).toBe(404);
  });
});

/**
 * Hold each partial-refund caller for `orderId` right AFTER its ledger claim CAS lands
 * (an insert: `expected === null`) until `callers` claims exist, then release them
 * together — so every caller reads the cumulative with ALL claims in flight. One-shot
 * per caller; a fallback releases the gate so a path that never claims fails
 * `arrivals()` instead of hanging.
 */
function holdAfterRefundClaims(orderId: string, callers: number): { arrivals: () => number } {
  const storage = hostExtStorage();
  const realCas = storage.kvCompareAndSwap.bind(storage);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fallback = setTimeout(() => release(), 2_000);
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
    const ok = await realCas(key, expected, next);
    if (ok && expected === null && key.startsWith('hostext:commerce:refund:') && key.includes(orderId) && arrived < callers) {
      arrived += 1;
      if (arrived >= callers) { clearTimeout(fallback); release(); }
      await gate;
    }
    return ok;
  });
  return { arrivals: () => arrived };
}

describe('ADR 0875 D8 — approvals bind to what they approved', () => {
  it('a quote-send approval for one total does not send a revised, larger quote', async () => {
    const { owner, orgId, tenantId } = await shop();
    await setGovernancePolicy(tenantId, { commerce: { orderApprovalThresholdMinor: 10_000 } }, 'test');
    try {
    const p = await owner.post(c(orgId, '/products'), { type: 'service', name: 'Retainer', price: 150, currency: 'USD' });
    const q = await owner.post(c(orgId, '/quotes'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    const qid: string = q.body.quoteId;
    expect((await owner.post(c(orgId, `/quotes/${encodeURIComponent(qid)}/send`))).status).toBe(409);
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey?.startsWith(`commerce-quote-send:${qid}:`));
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    // Revise the still-draft quote to 10× and send: RED on main ⇒ 'sent' on the old approval.
    await owner.patch(c(orgId, `/quotes/${encodeURIComponent(qid)}`), { lines: [{ productId: p.body.productId, quantity: 10 }] });
    const resend = await owner.post(c(orgId, `/quotes/${encodeURIComponent(qid)}/send`));
    expect(resend.status, JSON.stringify(resend.body)).toBe(409);
    expect(resend.body.error).toBe('approval_required');
    } finally {
      await setGovernancePolicy(tenantId, { commerce: {} }, 'test');
    }
  });

  it('partial refunds cannot be split under the refund threshold', async () => {
    const { owner, orgId, tenantId } = await shop();
    await setGovernancePolicy(tenantId, { commerce: { refundApprovalThresholdMinor: 5_000 } }, 'test'); // $50
    try {
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Bundle', price: 200, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    intents.set(`pi_split_${o.body.orderId}`, { amount: 20000, currency: 'usd', status: 'succeeded', metadata: { orderId: o.body.orderId, tenantId, orgId } });
    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: `pi_split_${o.body.orderId}` })).status).toBe(200);
    const r1 = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/partial-refund`), { amount: 40, refundKey: 'a' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    // 40 + 40 = 80 ≥ 50: the second slice must need a sign-off (RED on main: 200).
    const r2 = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/partial-refund`), { amount: 40, refundKey: 'b' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(409);
    expect(r2.body.error).toBe('approval_required');
    } finally {
      await setGovernancePolicy(tenantId, { commerce: {} }, 'test');
    }
  });

  it('concurrent partial refunds cannot each see zero refunded (architect H1)', async () => {
    const { owner, orgId, tenantId } = await shop();
    await setGovernancePolicy(tenantId, { commerce: { refundApprovalThresholdMinor: 5_000 } }, 'test');
    try {
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Bundle', price: 200, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    intents.set(`pi_race_${o.body.orderId}`, { amount: 20000, currency: 'usd', status: 'succeeded', metadata: { orderId: o.body.orderId, tenantId, orgId } });
    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: `pi_race_${o.body.orderId}` })).status).toBe(200);
    // FORCED window: each caller is held AFTER its refund claim lands and BEFORE it reads
    // the cumulative, until both have claimed. Unforced, the requests ran one after
    // another and the second always saw the first slice already folded, so the
    // "claims count" guard (`Math.max(claimedTotal, …)`) was never the deciding one.
    const held = holdAfterRefundClaims(o.body.orderId, 2);
    const refundsBefore = calls.filter((x) => x.path === '/refunds').length;
    const results = await Promise.all(['x', 'y'].map((k) => owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/partial-refund`), { amount: 30, refundKey: k })));
    expect(held.arrivals(), 'both slices were claimed before either read the cumulative').toBe(2);
    // Each reader sees BOTH claims ($60 ≥ $50), so BOTH park for sign-off. Reading only
    // the order's own refunded total would see $30 each and let both through.
    for (const r of results) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toBe('approval_required');
    }
    expect(calls.filter((x) => x.path === '/refunds').length, 'no refund reached Stripe').toBe(refundsBefore);
    const after = await getOrder(tenantId, orgId, o.body.orderId);
    expect(after?.status).toBe('paid');
    expect(after?.refundedAmount ?? 0).toBe(0);
    } finally {
      await setGovernancePolicy(tenantId, { commerce: {} }, 'test');
    }
  });
});

describe('ADR 0875 D9 — subscription cycles are not a free paid-order mint on a live host', () => {
  it('refuses a manual /cycle while the platform key resolves', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Monthly', price: 9, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });
    const sub = await owner.post(c(orgId, '/subscriptions'), { productId: p.body.productId, interval: 'monthly' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const ordersBefore = (await listOrders(tenantId, orgId)).length;
    const cyc = await owner.post(c(orgId, `/subscriptions/${encodeURIComponent(sub.body.subscription.subscriptionId)}/cycle`));
    expect(cyc.status, JSON.stringify(cyc.body)).toBe(409); // RED on main: 200 + a paid order
    expect(cyc.body.details?.code).toBe('live_subscription');
    expect((await listOrders(tenantId, orgId)).length, 'no order was minted').toBe(ordersBefore);
  });

  it('refuses a contactId from another tenant on subscribe', async () => {
    const a = await shop();
    const b = await shop();
    const foreign = await b.owner.post('/host/openwop-app/crm/contacts', { name: 'Other', email: `other-${n++}@x.test` });
    const p = await a.owner.post(c(a.orgId, '/products'), { type: 'digital', name: 'Monthly', price: 9, currency: 'USD', subscription: { enabled: true, intervals: ['monthly'] } });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    const sub = await a.owner.post(c(a.orgId, '/subscriptions'), { productId: p.body.productId, interval: 'monthly', contactId: foreign.body.contactId });
    expect(sub.status, JSON.stringify(sub.body)).toBe(400);
    expect(sub.body.message).toBe('contactId does not reference a contact in this tenant.');
  });
});

describe('ADR 0875 D7 — anon: tenants never open a live checkout', () => {
  it('an anon: storefront takes the demo branch', async () => {
    const owner = client();
    const tenantId = `anon:a0875-${Date.now()}-${n++}`;
    // LIST the anon tenant as a platform-settlement tenant: an UNLISTED tenant with no
    // seller takes the demo lane anyway, so without this the anon guard never decided
    // anything. DOUBLE GUARD (honest ceiling): `resolveStorefrontSettlement` refuses
    // anon first AND `isPlatformSettlementTenant` re-checks fold-eligibility, so removing
    // either one alone still lands on demo. Witness: probe `tlv-anon-predicate` (both
    // halves killed at the shared `isFoldEligibleTenant`) reds this case; a single-half
    // probe (`tlv-anon-demo`) is vacuous by design.
    process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS = [process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS, tenantId].filter(Boolean).join(',');
    const login = await owner.post('/host/openwop-app/test/login', { email: `anon-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await owner.post('/host/openwop-app/orgs', { name: 'Anon Shop' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const p = await owner.post(c(org.body.orgId, '/products'), { type: 'digital', name: 'Thing', price: 10, currency: 'USD' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const before = calls.filter((x) => x.path === '/checkout/sessions').length;
    const co = await client().post(pub(org.body.orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.mode, JSON.stringify(co.body)).toBe('demo');
    expect(calls.filter((x) => x.path === '/checkout/sessions').length).toBe(before);
  });
});

describe('ADR 0875 grade-code fold-ins (COM2CD-1/2/3/5)', () => {
  it('a re-delivered payment for an already-paid order is idempotent; a different intent is still refused (COM2CD-1)', async () => {
    const { owner, orgId, tenantId } = await shop();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    const pi = `pi_twice_${n++}`;
    intents.set(pi, { amount: 4000, currency: 'usd', status: 'succeeded', metadata: { orderId: o.body.orderId, tenantId, orgId } });
    await markAsPaid(tenantId, orgId, o.body.orderId, pi, { stripeKey: 'sk_test_mock' });
    // The session event and the intent event both land: the second is not a money alarm.
    expect((await markAsPaid(tenantId, orgId, o.body.orderId, pi, { stripeKey: 'sk_test_mock' }))?.status).toBe('paid');
    await expect(markAsPaid(tenantId, orgId, o.body.orderId, 'pi_other', { stripeKey: 'sk_test_mock' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a foreign intent is refused WITHOUT echoing its status or amount (COM2CD-3)', async () => {
    const { owner, orgId } = await shop();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    intents.set('pi_probe', { amount: 1234, currency: 'eur', status: 'requires_capture', metadata: { orderId: 'ord:x', tenantId: 'org:x', orgId: 'org:x' } });
    const r = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'pi_probe' });
    expect(r.status).toBe(409);
    expect(r.body.details?.code).toBe('payment_intent_mismatch'); // refused by the BINDING, first
    expect(JSON.stringify(r.body)).not.toMatch(/requires_capture|1234|eur/i);
  });

  it('an order cannot link another tenant\'s contact through the workflow surface (COM2CD-5)', async () => {
    const a = await shop();
    const b = await shop();
    const foreign = await b.owner.post('/host/openwop-app/crm/contacts', { name: 'Other', email: `oth-${n++}@x.test` });
    const p = await a.owner.post(c(a.orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const { buildFeatureSurfaces } = await import('../src/host/featureSurfaces.js');
    const system = buildFeatureSurfaces({ tenantId: a.tenantId, runId: 'r-sys-0875' }).commerce!;
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    await expect(system.createOrder!({ orgId: a.orgId, contactId: foreign.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] })).rejects.toMatchObject({ code: 'validation_error', message: 'contactId does not reference a contact in this tenant.' });
  });
});

