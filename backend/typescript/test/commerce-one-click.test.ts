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
import type { Product } from '../src/features/commerce/commerceService.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { publishedFunnel } from './helpers/publishedFunnel.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import {
  getOrder, markAsPaid, captureSavedPmFromPaidIntent, getSavedPaymentMethodForOrder,
  deleteSavedPaymentMethodsForContact, listChildOrders,
} from '../src/features/commerce/commerceService.js';
import { mintOneClickToken } from '../src/features/commerce/oneClickToken.js';
import { mintFunnelOfferToken } from '../src/features/funnels/offerDecisions.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}

let BASE: string; let server: http.Server; let n = 0;
let stripe: http.Server;
let stripeCalls: Array<{ path: string; body: string; idem?: string }> = [];
const intentAmounts = new Map<string, { amount: number; currency: string; metadata: Record<string, string> }>();
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
      const idem = req.headers['idempotency-key'];
      stripeCalls.push({ path: req.url ?? '', body: raw, idem: typeof idem === 'string' ? idem : undefined });
      const reply = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/v1/payment_intents') {
        if (intentOutcome === 'succeeded') {
          const id = `pi_${stripeCalls.length}`;
          const form = new URLSearchParams(raw);
          // ADR 0875 D3 — echo the intent's own metadata, which binds it to its order.
          const metadata: Record<string, string> = {};
          for (const k of ['orderId', 'tenantId', 'orgId']) { const v = form.get(`metadata[${k}]`); if (v) metadata[k] = v; }
          intentAmounts.set(id, { amount: Number(form.get('amount') ?? 0), currency: String(form.get('currency') ?? 'usd'), metadata });
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
        const known = intentAmounts.get(id) ?? { amount: 0, currency: 'usd', metadata: {} };
        reply(200, { id, status: 'succeeded', ...known });
        return;
      }
      if (req.url === '/v1/checkout/sessions') { reply(200, { id: `cs_${stripeCalls.length}`, url: 'https://checkout.stripe.test/s' }); return; }
      if (req.url === '/v1/customers') { reply(200, { id: 'cus_1' }); return; }
      reply(200, { id: `obj_${stripeCalls.length}` });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${portOf(stripe)}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await setSecret('billing:stripe-key', 'sk_test_mock');
});
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS; // ADR 0877 — set per shop above
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});

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
/** The public checkout's success body (the fields this suite reads). */
interface CheckoutBody { orderId: string; mode?: string; total?: number }
/** The one-click route answers one of four shapes (201 paid / 200 duplicate /
 *  202 SCA / 402 declined) or the error envelope — every field optional. */
interface OneClickBody extends Partial<ApiError> {
  orderId?: string; status?: string; paid?: boolean; duplicate?: boolean;
  requiresAction?: boolean; clientSecret?: string; declined?: boolean; reason?: string;
}
interface LoginBody { user?: { userId: string; tenantId?: string }; tenantId?: string }

/** A paid parent with a saved card. `viaFunnel`: bought through a funnel checkout,
 *  so it is extended only through the funnel's offer capability (ADR 0948 P2c). */
async function paidParentWithSavedPm(opts: { viaFunnel?: boolean } = {}) {
  const owner = client();
  const login = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `oc-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = login.body.user?.tenantId ?? '';
  // ADR 0877 — this suite drives the PLATFORM-lane one-click, which only an
  // operator tenant may use; list this shop on the explicit platform list.
  process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS = [process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS, tenantId].filter(Boolean).join(',');
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'OneClick Shop' });
  const orgId: string = org.body.orgId;
  const c = (sfx: string): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${sfx}`;
  const main = await owner.post<Product>(c('/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
  const upsell = await owner.post<Product>(c('/products'), { type: 'digital', name: 'Coaching', price: 50, currency: 'USD' });
  const upsell2 = await owner.post<Product>(c('/products'), { type: 'digital', name: 'Extra A', price: 10, currency: 'USD' });
  const upsell3 = await owner.post<Product>(c('/products'), { type: 'digital', name: 'Extra B', price: 10, currency: 'USD' });
  const upsell4 = await owner.post<Product>(c('/products'), { type: 'digital', name: 'Extra C', price: 10, currency: 'USD' });

  // ADR 0948 D2 — the funnel ref names a REAL published checkout step of this org.
  const fn = await publishedFunnel(tenantId, orgId, [
    { kind: 'checkout', offer: { productIds: [main.body.productId] } },
    { kind: 'upsell', offer: { productIds: [upsell.body.productId], oneClickProductId: upsell.body.productId } },
  ]);
  const funnelRef = { funnelId: fn.funnelId, stepId: fn.stepIds[0]! };
  // guest checkout WITH consent — live mode creates the session (mock stripe)
  const guest = client();
  const email = `buyer-${n++}@x.test`;
  const co = await guest.post<CheckoutBody>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
    email, lines: [{ productId: main.body.productId, quantity: 1 }], savePaymentMethod: true,
    ...(opts.viaFunnel ? { funnel: funnelRef } : {}),
  });
  expect(co.status).toBe(201);
  const orderId: string = co.body.orderId;
  // settle it + capture the saved PM the way the webhook does
  await markAsPaid(tenantId, orgId, orderId, 'pi_parent', { actor: 'test' });
  const order = await getOrder(tenantId, orgId, orderId);
  expect(order?.pmSaveRequested).toBe(true);
  const captured = await captureSavedPmFromPaidIntent(order!, { customer: 'cus_1', payment_method: 'pm_1' });
  expect(captured).toBe(true);
  // ADR 0875 D2 — the capability the success URL carries for THIS order.
  const oc = mintOneClickToken(tenantId, orgId, orderId);
  const ft = mintFunnelOfferToken(tenantId, orgId, orderId, fn.funnelId);
  return { guest, oc, ft, tenantId, orgId, orderId, contactId: order!.contactId!, mainId: main.body.productId, upsellId: upsell.body.productId, extras: [upsell2.body.productId, upsell3.body.productId, upsell4.body.productId], funnelRef, upsellStepRef: { funnelId: fn.funnelId, stepId: fn.stepIds[1]! } };
}

const oneClick = (orgId: string, orderId: string): string =>
  `/host/openwop-app/public-store/${encodeURIComponent(orgId)}/orders/${encodeURIComponent(orderId)}/one-click`;

describe('ADR 0296 P2/P3 — saved PM + one-click chains', () => {
  it('is 503 not_configured until the operator opts in', async () => {
    delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
    const v = client();
    const res = await v.post<OneClickBody>(oneClick('any-org', 'any-order'), { productId: 'p' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
  });

  it('capture only persists for orders that REQUESTED the save', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    const { guest, tenantId, orgId, orderId, mainId } = await paidParentWithSavedPm();
    expect(await getSavedPaymentMethodForOrder(tenantId, orgId, orderId)).toMatchObject({ stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1' });
    // A REAL paid order whose checkout did NOT tick "save" (same shop, a linked
    // contact, so only the consent marker can refuse it) never captures.
    const co = await guest.post<CheckoutBody>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
      email: `nosave-${n++}@x.test`, lines: [{ productId: mainId, quantity: 1 }],
    });
    expect(co.status).toBe(201);
    await markAsPaid(tenantId, orgId, co.body.orderId, 'pi_nosave', { actor: 'test' });
    const unconsented = (await getOrder(tenantId, orgId, co.body.orderId))!;
    expect(unconsented.contactId).toBeTruthy();
    expect(unconsented.pmSaveRequested).toBeFalsy();
    expect(await captureSavedPmFromPaidIntent(unconsented, { customer: 'cus_x', payment_method: 'pm_x' })).toBe(false);
    expect(await getSavedPaymentMethodForOrder(tenantId, orgId, co.body.orderId)).toBeNull();
  });

  it('one-click success: server-priced child, upsell origin, parent link, idempotency key', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    intentOutcome = 'succeeded';
    const { guest, oc, tenantId, orgId, orderId, upsellId } = await paidParentWithSavedPm();
    stripeCalls = [];
    const res = await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: upsellId, price: 1 /* hostile client price — ignored */ });
    expect(res.status).toBe(201);
    expect(res.body.paid).toBe(true);
    expect(res.body.orderId).toEqual(expect.any(String));
    const child = await getOrder(tenantId, orgId, res.body.orderId ?? '');
    expect(child?.parentOrderId).toBe(orderId);
    expect(child?.status).toBe('paid');
    expect(child?.items[0]?.origin).toBe('upsell');
    expect(child?.total).toBe(50); // server-resolved price, never the client's
    // A storefront purchase carries no funnel stamp. (A FUNNEL purchase is never
    // extended through `oc` at all since ADR 0948 P2c: see the next test.)
    expect(child?.funnelRef).toBeUndefined();
    const intentCall = stripeCalls.find((c) => c.path === '/v1/payment_intents');
    expect(intentCall?.idem).toBe(`oneclick:${orderId}:${upsellId}`);
    const form = new URLSearchParams(intentCall?.body ?? '');
    expect(form.get('amount')).toBe('5000'); // 50 USD in minor units
    expect(form.get('off_session')).toBe('true');
    expect(form.get('confirm')).toBe('true');

    // duplicate accept returns the SAME child — no second charge
    const again = await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: upsellId });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.orderId).toBe(res.body.orderId);
  });

  it('SCA challenge → 202 + clientSecret (child pending); decline → child canceled + 402', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    const { guest, oc, tenantId, orgId, orderId, upsellId, extras } = await paidParentWithSavedPm();
    try {
      intentOutcome = 'authentication_required';
      const sca = await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: upsellId });
      expect(sca.status).toBe(202);
      expect(sca.body.requiresAction).toBe(true);
      expect(sca.body.clientSecret).toBe('cs_sca');
      expect(sca.body.orderId).toEqual(expect.any(String));
      expect((await getOrder(tenantId, orgId, sca.body.orderId ?? ''))?.status).toBe('pending');

      intentOutcome = 'card_declined';
      const declined = await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: extras[0] });
      expect(declined.status).toBe(402);
      expect(declined.body.declined).toBe(true);
      // The declined CHILD is released (canceled) so the funnel can downsell and it
      // stops counting toward the chain limit — the 402 alone cannot show that.
      const kids = await listChildOrders(tenantId, orgId, orderId);
      const declinedChild = kids.find((k) => k.items[0]?.productId === extras[0]);
      expect(declinedChild?.status).toBe('canceled');
    } finally {
      intentOutcome = 'succeeded';
    }
  });

  it('ADR 0948 D2 — naming a funnel step, one-click charges only that step\'s offered product', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    intentOutcome = 'succeeded';
    const { guest, oc, ft, tenantId, orgId, orderId, upsellId, extras, funnelRef, upsellStepRef } = await paidParentWithSavedPm({ viaFunnel: true });
    // ADR 0948 P2c — a funnel purchase is never extended through the storefront's
    // `oc`, with or without a funnel ref: only the funnel's own capability works.
    expect((await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: upsellId })).status).toBe(404);
    expect((await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: upsellId, funnel: upsellStepRef })).status).toBe(404);
    // Not the step's one-click product → refused before anything reaches Stripe.
    stripeCalls = [];
    const bad = await guest.post<OneClickBody>(oneClick(orgId, orderId), { ft, productId: extras[0], funnel: upsellStepRef });
    expect([bad.status, bad.body.details?.code]).toEqual([400, 'one_click_not_offered']);
    expect(stripeCalls.some((c) => c.path.endsWith('/payment_intents'))).toBe(false); // Stripe's own API path
    // A checkout step is not an upsell step: the same uniform 400 as an unknown one.
    const wrongKind = await guest.post<OneClickBody>(oneClick(orgId, orderId), { ft, productId: upsellId, funnel: funnelRef });
    expect([wrongKind.status, wrongKind.body.details?.code]).toEqual([400, 'funnel_step_not_found']);
    // The offered product on the named upsell step is accepted, stamped with that step.
    const ok = await guest.post<OneClickBody>(oneClick(orgId, orderId), { ft, productId: upsellId, funnel: upsellStepRef });
    expect(ok.status).toBe(201);
    expect((await getOrder(tenantId, orgId, ok.body.orderId ?? ''))?.funnelRef).toEqual(upsellStepRef);
  });

  it('caps the chain at 3 non-canceled children and 404s foreign/unpaid orders', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    intentOutcome = 'succeeded';
    const { guest, oc, orgId, orderId, upsellId, extras } = await paidParentWithSavedPm();
    for (const pid of [upsellId, ...extras.slice(0, 2)]) {
      expect((await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: pid })).status).toBe(201);
    }
    const fourth = await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: extras[2] });
    expect(fourth.status).toBe(400);
    expect(fourth.body.details?.code).toBe('chain_limit');
    expect((await guest.post<OneClickBody>(oneClick(orgId, 'order-nope'), { productId: upsellId })).status).toBe(404);
  });

  it('a REAL paid parent without its capability token, and an UNPAID parent with one, both 404', async () => {
    // A nonexistent order is refused by the `!parent` half and cannot witness the
    // token or the paid-status branch, so each refusal gets a real order.
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    intentOutcome = 'succeeded';
    const { guest, oc, tenantId, orgId, orderId, upsellId, mainId } = await paidParentWithSavedPm();
    const noToken = await guest.post<OneClickBody>(oneClick(orgId, orderId), { productId: upsellId });
    expect(noToken.status).toBe(404);
    expect(noToken.body.error).toBe('not_found');
    const wrongToken = await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc: mintOneClickToken(tenantId, orgId, 'some-other-order'), productId: upsellId });
    expect(wrongToken.status).toBe(404);
    // unpaid: a pending order with a VALID token for itself
    const co = await guest.post<CheckoutBody>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
      email: `unpaid-${n++}@x.test`, lines: [{ productId: mainId, quantity: 1 }], savePaymentMethod: true,
    });
    expect(co.status).toBe(201);
    const unpaid = await guest.post<OneClickBody>(oneClick(orgId, co.body.orderId), { oc: mintOneClickToken(tenantId, orgId, co.body.orderId), productId: upsellId });
    expect(unpaid.status).toBe(404);
    // positive control: the SAME parent + product WITH its token is accepted
    expect((await guest.post<OneClickBody>(oneClick(orgId, orderId), { oc, productId: upsellId })).status).toBe(201);
  });

  it('a contact deletion prunes the saved payment reference (seam consumer)', async () => {
    process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
    const { tenantId, orgId, orderId, contactId } = await paidParentWithSavedPm();
    expect(await getSavedPaymentMethodForOrder(tenantId, orgId, orderId)).not.toBeNull();
    await deleteSavedPaymentMethodsForContact(tenantId, contactId);
    expect(await getSavedPaymentMethodForOrder(tenantId, orgId, orderId)).toBeNull();
  });
});
