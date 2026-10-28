/**
 * ADR 0948 P2c — money steps in the funnel viewer: the server half. A funnel
 * checkout sells exactly its offer; the buyer's post-purchase offers (upsell,
 * downsell) are extended only through the funnel's own capability, once per step,
 * on the step the funnel's own routing reaches; routing past an offer step follows
 * the recorded decision, never the visitor. Against a mock Stripe HTTP server (the
 * commerce-one-click precedent): no live Stripe call.
 *
 * Fixture funnel: checkout {main | alt, bump} → upsell {up; accepted → thankyou}
 * → downsell {down} → thankyou. Platform lane, one-click enabled.
 *
 * Legs:
 *  1. Amount and offer: one main line of an offered product at quantity 1; bumps
 *     distinct, offered, quantity 1; posted prices ignored; the live success URL
 *     returns to the funnel with the capability in the FRAGMENT (no `oc`).
 *  2. Single use: accept charges once (per-step idempotency key); a replay returns
 *     the same purchase with no second charge; the downsell is then closed; decline
 *     then accept is refused; concurrent accepts charge once.
 *  3. Binding: another funnel's ref, a missing/forged token, `oc`, quantity 2, an
 *     unpaid parent, and an expired window are refused.
 *  4. Failure modes: an unknown Stripe outcome holds the step `charging` (routes as
 *     the end of the offers, never a downsell); a bank challenge is a decline.
 *  5. Routing: a client `outcome` on an offer step is refused; with the capability
 *     headers an accept routes to thank-you and a decline to the downsell; without
 *     them, sequential.
 *
 * Sabotage-witnessed (each alone turns a leg red): the one-offered-main-line check
 * (amount), the bump dedupe/quantity check (bump), `putIfAbsent` → `put` on the
 * decision claim (single use: the claim leg), the token HMAC check and the parent's
 * funnel binding (binding), upsell/downsell in SERVER_OUTCOME_KINDS (routing), the
 * reachability check (single use + routing), `charging` routing as accepted
 * (failure modes), and the funnel one-click quantity cap. The concurrent-accept leg
 * stays green with the claim sabotaged, because reachability serialises those
 * requests in practice; the claim leg is its witness.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import type { Product } from '../src/features/commerce/commerceService.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { getOrder, markAsPaid, captureSavedPmFromPaidIntent, listChildOrders } from '../src/features/commerce/commerceService.js';
import { mintOneClickToken } from '../src/features/commerce/oneClickToken.js';
import { mintFunnelOfferToken, offerParentValid, getOfferDecision, claimOfferDecision, FUNNEL_OFFER_WINDOW_MS } from '../src/features/funnels/offerDecisions.js';
import { createFunnel, publishFunnel } from '../src/features/funnels/funnelsService.js';

function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('not a TCP server');
  return a.port;
}

/** Stripe's OWN API paths, served by the mock below (not the OpenWOP v1 wire). */
const STRIPE_INTENTS = '/v1/payment_intents';
const STRIPE_SESSIONS = '/v1/checkout/sessions';
const STRIPE_CUSTOMERS = '/v1/customers';

let BASE: string; let server: http.Server; let stripe: http.Server; let n = 0;
let stripeCalls: Array<{ path: string; body: string; idem?: string }> = [];
const intents = new Map<string, { amount: number; currency: string; metadata: Record<string, string> }>();
let intentOutcome: 'succeeded' | 'authentication_required' | 'card_declined' | 'error' = 'succeeded';
let intentDelayMs = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const idem = req.headers['idempotency-key'];
      stripeCalls.push({ path: req.url ?? '', body: raw, idem: typeof idem === 'string' ? idem : undefined });
      const reply = (status: number, body: Record<string, unknown>): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === STRIPE_INTENTS) {
        setTimeout(() => {
          if (intentOutcome === 'error') { reply(500, { error: { type: 'api_error', message: 'upstream timeout' } }); return; }
          if (intentOutcome === 'authentication_required') { reply(402, { error: { code: 'authentication_required', message: 'SCA', payment_intent: { id: 'pi_sca', client_secret: 'cs_sca' } } }); return; }
          if (intentOutcome === 'card_declined') { reply(402, { error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'declined' } }); return; }
          const id = `pi_${stripeCalls.length}`;
          const form = new URLSearchParams(raw);
          const metadata: Record<string, string> = {};
          for (const k of ['orderId', 'tenantId', 'orgId']) { const v = form.get(`metadata[${k}]`); if (v) metadata[k] = v; }
          intents.set(id, { amount: Number(form.get('amount') ?? 0), currency: String(form.get('currency') ?? 'usd'), metadata });
          reply(200, { id, status: 'succeeded' });
        }, intentDelayMs);
        return;
      }
      if (req.url?.startsWith(`${STRIPE_INTENTS}/`)) {
        const id = req.url.split('/').pop() ?? '';
        reply(200, { id, status: 'succeeded', ...(intents.get(id) ?? { amount: 0, currency: 'usd', metadata: {} }) });
        return;
      }
      if (req.url === STRIPE_SESSIONS) { reply(200, { id: `cs_${stripeCalls.length}`, url: 'https://checkout.stripe.test/s' }); return; }
      if (req.url === STRIPE_CUSTOMERS) { reply(200, { id: 'cus_1' }); return; }
      reply(200, { id: `obj_${stripeCalls.length}` });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${portOf(stripe)}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm', 'funnels', 'cms']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await setSecret('billing:stripe-key', 'sk_test_mock');
});
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS;
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});

interface Res<T = Record<string, unknown>> { status: number; body: T }
function client(headers: Record<string, string> = {}) {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...extra, ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed as T };
  };
  return {
    get: <T = Record<string, unknown>>(p: string, extra?: Record<string, string>) => call<T>('GET', p, undefined, extra),
    post: <T = Record<string, unknown>>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}
type Body = Record<string, unknown> & { details?: { code?: string }; orderId?: string };
const store = (orgId: string, sfx: string): string => `/host/openwop-app/public-store/${encodeURIComponent(orgId)}${sfx}`;

/** A shop with a published money funnel (explicit stepIds so routing can name them). */
async function shop() {
  const owner = client();
  const login = await owner.post<{ user?: { tenantId?: string } }>('/host/openwop-app/test/login', { email: `p2c-${Date.now()}-${n++}@acme.test` });
  const tenantId = login.body.user?.tenantId ?? '';
  process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS = [process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS, tenantId].filter(Boolean).join(',');
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Money Funnel Shop' })).body.orgId;
  const c = (sfx: string): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${sfx}`;
  const product = async (name: string, price: number): Promise<string> => (await owner.post<Product>(c('/products'), { type: 'digital', name, price, currency: 'USD' })).body.productId;
  const p = { main: await product('Course', 100), alt: await product('Course lite', 80), bump: await product('Workbook', 15), up: await product('Coaching', 50), down: await product('Coaching lite', 30), other: await product('Unoffered', 5) };
  const page = async (title: string): Promise<string> => {
    // Published through the CMS route: the public funnel serves only published pages.
    const created = await owner.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title, sections: [{ type: 'hero', data: { heading: title } }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await owner.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`)).status).toBe(200);
    return created.body.pageId;
  };
  const mk = async (tag: string) => {
    const f = await createFunnel({
      tenantId, orgId, createdBy: 'test', name: `Money ${tag} ${n++}`,
      steps: [
        { stepId: 'checkout', kind: 'checkout', pageId: await page(`Checkout ${tag}`), offer: { productIds: [p.main, p.alt], bumpProductIds: [p.bump] } },
        { stepId: 'upsell', kind: 'upsell', pageId: await page(`Upsell ${tag}`), offer: { productIds: [p.up], oneClickProductId: p.up }, routing: [{ when: { outcome: 'accepted' }, goto: 'thankyou' }] },
        { stepId: 'downsell', kind: 'downsell', pageId: await page(`Downsell ${tag}`), offer: { productIds: [p.down], oneClickProductId: p.down } },
        { stepId: 'thankyou', kind: 'thankyou', pageId: await page(`Thanks ${tag}`) },
      ],
    } as never);
    const pub = await publishFunnel(tenantId, orgId, f.funnelId);
    expect(pub?.status, JSON.stringify(pub)).toBe('published');
    return f;
  };
  return { tenantId, orgId, p, funnel: await mk('A'), other: await mk('B') };
}

/** A paid funnel parent with the saved card captured the way the webhook does. */
async function paidParent(s: Awaited<ReturnType<typeof shop>>, lines?: unknown[]) {
  const guest = client();
  stripeCalls = [];
  const co = await guest.post<Body>(store(s.orgId, '/checkout'), {
    email: `buyer-${n++}@x.test`, savePaymentMethod: true,
    lines: lines ?? [{ productId: s.p.main, quantity: 1 }],
    funnel: { funnelId: s.funnel.funnelId, stepId: 'checkout' },
  });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const orderId = co.body.orderId!;
  await markAsPaid(s.tenantId, s.orgId, orderId, `pi_parent_${n++}`, { actor: 'test' });
  const order = await getOrder(s.tenantId, s.orgId, orderId);
  expect(await captureSavedPmFromPaidIntent(order!, { customer: 'cus_1', payment_method: 'pm_1' })).toBe(true);
  return { guest, orderId, ft: mintFunnelOfferToken(s.tenantId, s.orgId, orderId, s.funnel.funnelId) };
}
const accept = (g: ReturnType<typeof client>, s: Awaited<ReturnType<typeof shop>>, orderId: string, body: Record<string, unknown>) =>
  g.post<Body>(store(s.orgId, `/orders/${encodeURIComponent(orderId)}/one-click`), body);
const decline = (g: ReturnType<typeof client>, s: Awaited<ReturnType<typeof shop>>, orderId: string, body: Record<string, unknown>) =>
  g.post<Body>(store(s.orgId, `/orders/${encodeURIComponent(orderId)}/funnel-decline`), body);
const intentCalls = (): number => stripeCalls.filter((c) => c.path === STRIPE_INTENTS).length;
const nextStep = (s: Awaited<ReturnType<typeof shop>>, from: string, headers?: Record<string, string>, outcome?: string) =>
  client().get<{ step?: { stepId: string }; complete?: boolean } & Body>(`/host/openwop-app/public/${encodeURIComponent(s.orgId)}/funnels/${encodeURIComponent(s.funnel.slug)}/next?from=${from}${outcome ? `&outcome=${outcome}` : ''}`, headers);

describe('ADR 0948 P2c — a funnel checkout sells exactly its offer', () => {
  it('one offered main product at quantity 1, distinct offered bumps; catalog prices; fragment return URL', async () => {
    const s = await shop();
    const g = client();
    const ref = { funnelId: s.funnel.funnelId, stepId: 'checkout' };
    const co = (body: Record<string, unknown>) => g.post<Body>(store(s.orgId, '/checkout'), { email: `amt-${n++}@x.test`, funnel: ref, ...body });
    expect((await co({ lines: [{ productId: s.p.other, quantity: 1 }] })).body.details?.code).toBe('product_not_offered');
    expect((await co({ lines: [{ productId: s.p.main, quantity: 1 }, { productId: s.p.alt, quantity: 1 }] })).body.details?.code).toBe('product_not_offered');
    expect((await co({ lines: [{ productId: s.p.main, quantity: 2 }] })).body.details?.code).toBe('product_not_offered');
    expect((await co({ lines: [{ productId: s.p.main, quantity: 1 }], bumps: [{ productId: s.p.other }] })).body.details?.code).toBe('bump_not_offered');
    expect((await co({ lines: [{ productId: s.p.main, quantity: 1 }], bumps: [{ productId: s.p.bump }, { productId: s.p.bump }] })).body.details?.code).toBe('bump_not_offered');
    expect((await co({ lines: [{ productId: s.p.main, quantity: 1 }], bumps: [{ productId: s.p.bump, quantity: 3 }] })).body.details?.code).toBe('bump_not_offered');

    stripeCalls = [];
    const ok = await co({ lines: [{ productId: s.p.alt, quantity: 1, price: 0.01, unitPrice: 0.01 }], bumps: [{ productId: s.p.bump, price: 0 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const order = await getOrder(s.tenantId, s.orgId, ok.body.orderId!);
    expect(order?.total).toBe(95); // 80 + 15, the catalog's prices, never the page's
    const session = new URLSearchParams(stripeCalls.find((c) => c.path === STRIPE_SESSIONS)?.body ?? '');
    const success = session.get('success_url') ?? '';
    expect(success).toContain(`/fn/${encodeURIComponent(s.orgId)}/${encodeURIComponent(s.funnel.slug)}?step=0&paid=1#order=`);
    expect(success).toContain(`&ft=${encodeURIComponent(mintFunnelOfferToken(s.tenantId, s.orgId, order!.orderId, s.funnel.funnelId))}`);
    expect(success.split('#')[0]).not.toContain('ft=');
    expect(success).not.toContain('oc=');
    expect(session.get('cancel_url')).toContain('?step=0&canceled=1');
  });
});

describe('ADR 0948 P2c — post-purchase offers: once per step, on the reached step', () => {
  it('accept charges once with a per-step key; a replay returns it uncharged; the downsell is closed', async () => {
    const s = await shop(); intentOutcome = 'succeeded'; intentDelayMs = 0;
    const { guest, orderId, ft } = await paidParent(s);
    const up = { funnelId: s.funnel.funnelId, stepId: 'upsell' };
    stripeCalls = [];
    const r = await accept(guest, s, orderId, { productId: s.p.up, funnel: up, ft });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(intentCalls()).toBe(1);
    expect(stripeCalls.find((c) => c.path === STRIPE_INTENTS)?.idem).toBe(`oneclick:${orderId}:${s.funnel.funnelId}:upsell`);
    expect((await getOrder(s.tenantId, s.orgId, r.body.orderId!))?.total).toBe(50);
    const again = await accept(guest, s, orderId, { productId: s.p.up, funnel: up, ft });
    expect([again.status, again.body.orderId, again.body.duplicate]).toEqual([200, r.body.orderId, true]);
    expect(intentCalls(), 'a replay must not charge again').toBe(1);
    // Accepted routes to thank-you: the downsell is not the reached step.
    expect((await accept(guest, s, orderId, { productId: s.p.down, funnel: { funnelId: s.funnel.funnelId, stepId: 'downsell' }, ft })).status).toBe(404);
    expect((await decline(guest, s, orderId, { funnel: up, ft })).status, 'no decline after an accept').toBe(404);
  });

  it('decline then accept is refused; the downsell opens; concurrent accepts charge once', async () => {
    const s = await shop(); intentOutcome = 'succeeded';
    const { guest, orderId, ft } = await paidParent(s);
    const up = { funnelId: s.funnel.funnelId, stepId: 'upsell' };
    const down = { funnelId: s.funnel.funnelId, stepId: 'downsell' };
    // The downsell is closed while the upsell is undecided.
    expect((await accept(guest, s, orderId, { productId: s.p.down, funnel: down, ft })).status).toBe(404);
    expect((await decline(guest, s, orderId, { funnel: up, ft })).status).toBe(200);
    stripeCalls = [];
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: up, ft })).status, 'accept after decline').toBe(404);
    expect(intentCalls()).toBe(0);
    intentDelayMs = 60;
    const both = await Promise.all([1, 2, 3].map(() => accept(guest, s, orderId, { productId: s.p.down, funnel: down, ft })));
    intentDelayMs = 0;
    expect(both.filter((b) => b.status === 201)).toHaveLength(1);
    expect(intentCalls(), 'concurrent accepts charged more than once').toBe(1);
    expect((await listChildOrders(s.tenantId, s.orgId, orderId)).filter((c) => c.status !== 'canceled')).toHaveLength(1);
  });

  it('a step has ONE decision: a second claim, from any request, gets nothing', async () => {
    // The route takes this claim before any order or charge. Reachability already
    // closes most replays; this is the guard for two requests that both read the
    // step as open before either writes (a window a route test cannot time).
    const key = `p2c-claim-${n++}`;
    const first = await claimOfferDecision('t-claim', 'o-claim', key, 'f-claim', 'upsell', 'charging');
    expect(first?.decision).toBe('charging');
    expect(await claimOfferDecision('t-claim', 'o-claim', key, 'f-claim', 'upsell', 'declined')).toBeNull();
    expect(await claimOfferDecision('t-claim', 'o-claim', key, 'f-claim', 'upsell', 'charging')).toBeNull();
    expect((await getOfferDecision('t-claim', key, 'f-claim', 'upsell'))?.decision).toBe('charging');
  });

  it('refuses another funnel, a forged or missing token, `oc`, quantity 2, an unpaid parent and an expired window', async () => {
    const s = await shop(); intentOutcome = 'succeeded';
    const { guest, orderId, ft } = await paidParent(s);
    const up = { funnelId: s.funnel.funnelId, stepId: 'upsell' };
    stripeCalls = [];
    // Funnel B has the same step ids and product: the token is bound to funnel A.
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: { funnelId: s.other.funnelId, stepId: 'upsell' }, ft })).status).toBe(404);
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: { funnelId: s.other.funnelId, stepId: 'upsell' }, ft: mintFunnelOfferToken(s.tenantId, s.orgId, orderId, s.other.funnelId) })).status, 'a parent stamped with funnel A').toBe(404);
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: up, ft: `${ft.slice(0, -2)}xx` })).status).toBe(404);
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: up })).status).toBe(404);
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: up, oc: mintOneClickToken(s.tenantId, s.orgId, orderId) })).status).toBe(404);
    expect((await accept(guest, s, orderId, { productId: s.p.up, funnel: up, ft, quantity: 2 })).status).toBe(400);
    expect(intentCalls()).toBe(0);
    // Unpaid parent: a fresh checkout, never paid.
    const unpaid = await guest.post<Body>(store(s.orgId, '/checkout'), { email: `u-${n++}@x.test`, lines: [{ productId: s.p.main, quantity: 1 }], funnel: { funnelId: s.funnel.funnelId, stepId: 'checkout' } });
    expect((await accept(guest, s, unpaid.body.orderId!, { productId: s.p.up, funnel: up, ft: mintFunnelOfferToken(s.tenantId, s.orgId, unpaid.body.orderId!, s.funnel.funnelId) })).status).toBe(404);
    // The window runs from payment, on the server's clock.
    const parent = await getOrder(s.tenantId, s.orgId, orderId);
    const paid = Date.parse(parent!.paidAt!);
    expect(offerParentValid(s.tenantId, s.orgId, parent, s.funnel.funnelId, ft, paid + FUNNEL_OFFER_WINDOW_MS - 1000)).toBe(true);
    expect(offerParentValid(s.tenantId, s.orgId, parent, s.funnel.funnelId, ft, paid + FUNNEL_OFFER_WINDOW_MS + 1000)).toBe(false);
  });

  it('an unknown Stripe outcome holds the step charging (routes as accepted); a bank challenge is a decline', async () => {
    const s = await shop();
    const { guest, orderId, ft } = await paidParent(s);
    const up = { funnelId: s.funnel.funnelId, stepId: 'upsell' };
    intentOutcome = 'error';
    const r = await accept(guest, s, orderId, { productId: s.p.up, funnel: up, ft });
    intentOutcome = 'succeeded';
    expect([r.status, r.body.pending]).toEqual([202, true]);
    expect((await getOfferDecision(s.tenantId, orderId, s.funnel.funnelId, 'upsell'))?.decision).toBe('charging');
    const child = await getOrder(s.tenantId, s.orgId, r.body.orderId!);
    expect(child?.status, 'the child stays for the webhook').toBe('pending');
    // Never a downsell after a possible charge.
    expect((await accept(guest, s, orderId, { productId: s.p.down, funnel: { funnelId: s.funnel.funnelId, stepId: 'downsell' }, ft })).status).toBe(404);
    const h = { 'x-openwop-funnel-order': orderId, 'x-openwop-funnel-offer': ft };
    expect((await nextStep(s, 'upsell', h)).body.step?.stepId).toBe('thankyou');

    const s2 = await shop();
    const b = await paidParent(s2);
    intentOutcome = 'authentication_required';
    const sca = await accept(b.guest, s2, b.orderId, { productId: s2.p.up, funnel: { funnelId: s2.funnel.funnelId, stepId: 'upsell' }, ft: b.ft });
    intentOutcome = 'succeeded';
    expect([sca.status, sca.body.declined, sca.body.reason]).toEqual([402, true, 'authentication_required']);
    expect((await getOfferDecision(s2.tenantId, b.orderId, s2.funnel.funnelId, 'upsell'))?.decision).toBe('declined');
    expect((await listChildOrders(s2.tenantId, s2.orgId, b.orderId)).every((c) => c.status === 'canceled')).toBe(true);
  });
});

describe('ADR 0948 P2c — routing past an offer step follows the recorded decision', () => {
  it('refuses a client outcome; accept → thank-you, decline → downsell, no capability → sequential', async () => {
    const s = await shop(); intentOutcome = 'succeeded';
    const forged = await nextStep(s, 'upsell', undefined, 'accepted');
    expect([forged.status, JSON.stringify(forged.body).includes('outcome_server_derived')]).toEqual([400, true]);
    const seq = await nextStep(s, 'upsell'); expect(seq.body.step?.stepId, JSON.stringify(seq)).toBe('downsell');

    const a = await paidParent(s);
    const h = (o: { orderId: string; ft: string }) => ({ 'x-openwop-funnel-order': o.orderId, 'x-openwop-funnel-offer': o.ft });
    expect((await nextStep(s, 'upsell', h(a))).body.step?.stepId, 'undecided: sequential').toBe('downsell');
    expect((await accept(a.guest, s, a.orderId, { productId: s.p.up, funnel: { funnelId: s.funnel.funnelId, stepId: 'upsell' }, ft: a.ft })).status).toBe(201);
    expect((await nextStep(s, 'upsell', h(a))).body.step?.stepId).toBe('thankyou');
    // Another buyer's capability reads nothing of this one's decision.
    const b = await paidParent(s);
    expect((await nextStep(s, 'upsell', { 'x-openwop-funnel-order': a.orderId, 'x-openwop-funnel-offer': b.ft })).body.step?.stepId).toBe('downsell');
    expect((await decline(b.guest, s, b.orderId, { funnel: { funnelId: s.funnel.funnelId, stepId: 'upsell' }, ft: b.ft })).status).toBe(200);
    expect((await nextStep(s, 'upsell', h(b))).body.step?.stepId).toBe('downsell');
  });

  it('the offer status read says paid/open only for the right capability', async () => {
    const s = await shop();
    const g = client();
    const co = await g.post<Body>(store(s.orgId, '/checkout'), { email: `st-${n++}@x.test`, savePaymentMethod: true, lines: [{ productId: s.p.main, quantity: 1 }], funnel: { funnelId: s.funnel.funnelId, stepId: 'checkout' } });
    const orderId = co.body.orderId!;
    const ft = mintFunnelOfferToken(s.tenantId, s.orgId, orderId, s.funnel.funnelId);
    const status = (body: Record<string, unknown>) => g.post<Body>(store(s.orgId, `/orders/${encodeURIComponent(orderId)}/funnel-offer`), body);
    const up = { funnelId: s.funnel.funnelId, stepId: 'upsell' };
    expect((await status({ funnel: up, ft })).body).toMatchObject({ paid: false, open: false });
    expect((await status({ funnel: up, ft: 'nope' })).status).toBe(404);
    await markAsPaid(s.tenantId, s.orgId, orderId, `pi_st_${n++}`, { actor: 'test' });
    expect((await status({ funnel: up, ft })).body).toMatchObject({ paid: true, open: true });
    expect((await status({ funnel: { funnelId: s.funnel.funnelId, stepId: 'downsell' }, ft })).body).toMatchObject({ paid: true, open: false });
  });
});
