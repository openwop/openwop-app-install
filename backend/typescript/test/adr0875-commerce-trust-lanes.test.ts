/**
 * ADR 0875 — commerce trust boundaries on the NON-HTTP lanes and the demo host.
 *
 *  - D5: `ctx.features.commerce` asks what the HTTP doors ask (a Viewer's run
 *    cannot refund, adjust stock, mint coupons or send quotes), the method
 *    partition is closed-world, and the `ucp*` verbs honour `commerce-ucp-buyer`.
 *  - D4: a UCP client sees and moves only the orders IT created; a deleted
 *    client's bearer stops working at once.
 *  - D6: the merchant fetch dials through the ONE pinned-resolution dispatcher.
 *  - D7: integer quantities, inactive products, the live-order cap, quantized
 *    prices; D9: payout CSV formula neutralisation.
 *
 * Every behavioural case was RED on `origin/main` @ `f7a216b78`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  buildCommerceSurface, COMMERCE_SURFACE_ORG_WRITERS, COMMERCE_SURFACE_READS,
} from '../src/features/commerce/surface.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE; // the de-facto-owner bypass would admit every refusal below
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm', 'commerce-ucp']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The JSON fields these cases read. Declared, not `any`: a field this file reads
 *  that the server does not send fails the assertion that reads it, and a typo
 *  fails `tsc`. */
interface WireBody {
  productId: string; orgId: string; orderId: string; id: string; clientId: string; clientSecret: string; access_token: string;
  price: number; active: boolean; total: number; items: { unitPrice: number }[]; message?: string; user: { userId: string };
}
interface Res<T = WireBody> { status: number; body: T; text?: string }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, bearer?: string): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    // The fetch boundary is the one place JSON enters untyped; a non-JSON body reads as {}.
    let out: WireBody; try { out = JSON.parse(text); } catch { out = JSON.parse('{}'); }
    return { status: res.status, body: out, text };
  };
  return {
    get: (p: string, bearer?: string) => call('GET', p, undefined, bearer),
    post: (p: string, b?: unknown, bearer?: string) => call('POST', p, b, bearer),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;
const pub = (orgId: string, s = ''): string => `/host/openwop-app/public-store/${encodeURIComponent(orgId)}${s}`;
const ucp = (orgId: string, s = ''): string => `/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}${s}`;

async function team(): Promise<{ owner: ReturnType<typeof client>; tenantId: string; orgId: string; editorId: string; viewerId: string }> {
  const tenantId = `org:a0875l-${Date.now()}-${n++}`;
  const ids: string[] = [];
  const owner = client();
  for (const cl of [owner, client(), client()]) {
    const r = await cl.post('/host/openwop-app/test/login', { email: `a0875l-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push(r.body.user.userId);
  }
  const [, editorId, viewerId] = ids as [string, string, string];
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme Store' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { owner, tenantId, orgId, editorId, viewerId };
}

describe('ADR 0875 D5 — the commerce surface method partition is closed-world', () => {
  it('every method is classified exactly once', () => {
    const methods = Object.keys(buildCommerceSurface({ tenantId: 't-partition' })).sort();
    const classified = [...COMMERCE_SURFACE_READS, ...COMMERCE_SURFACE_ORG_WRITERS] as string[];
    expect(new Set(classified).size, 'a method is in two sets').toBe(classified.length);
    expect(classified.sort()).toEqual(methods);
  });
});

describe('ADR 0875 D5 — a Viewer\'s run cannot write through ctx.features.commerce', () => {
  it('org writers need workspace:write in the named org', async () => {
    const t = await team();
    const p = await t.owner.post(c(t.orgId, '/products'), { type: 'physical', name: 'Widget', price: 10, currency: 'USD', inventory: 5 });
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v', actingUserId: t.viewerId }).commerce!;
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e', actingUserId: t.editorId }).commerce!;
    await expect(asViewer.adjustInventory!({ orgId: t.orgId, productId: p.body.productId, inventory: 999 })).rejects.toMatchObject({ code: 'forbidden_scope' }); // RED on main: adjusted
    await expect(asViewer.createCoupon!({ orgId: t.orgId, code: 'FREE100', type: 'percentage', value: 100 })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asViewer.createOrder!({ orgId: t.orgId, lines: [{ productId: p.body.productId, quantity: 1 }] })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await asViewer.listProducts!({ orgId: t.orgId })).toMatchObject({ products: [expect.objectContaining({ name: 'Widget' })] }); // reads stay at the read tier
    expect(await asEditor.adjustInventory!({ orgId: t.orgId, productId: p.body.productId, inventory: 7 })).toMatchObject({ product: expect.objectContaining({ inventory: 7 }) });
  });

  it('a write verb cannot skip the floor by omitting orgId', async () => {
    const t = await team();
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v3', actingUserId: t.viewerId }).commerce!;
    const noOrg = { code: 'validation_error', message: 'A commerce write needs an `orgId`.' };
    await expect(asViewer.ucpBuildCart!({ merchantUrl: 'https://merchant.test', intent: 'x', maxAmountMinor: 100, currency: 'USD', lines: [] })).rejects.toMatchObject(noOrg);
    await expect(asViewer.createCoupon!({ code: 'NOORG', type: 'percentage', value: 100 })).rejects.toMatchObject(noOrg);
  });

  it('the ucp* verbs honour the commerce-ucp-buyer toggle', async () => {
    const t = await team();
    const d = getToggleDefault('commerce-ucp-buyer');
    expect(d, 'the buyer toggle is registered').toBeDefined();
    try {
      await saveConfig({ ...d!, status: 'off' }, 'test');
      const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e2', actingUserId: t.editorId }).commerce!;
      await expect(asEditor.ucpListPurchases!({ orgId: t.orgId })).rejects.toMatchObject({ code: 'host_capability_disabled' }); // RED on main: []
      // Positive control: the SAME verb answers once the toggle is on, so the refusal
      // above is the toggle and not some other failure.
      await saveConfig({ ...d!, status: 'on' }, 'test');
      const asEditorOn = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e3', actingUserId: t.editorId }).commerce!;
      expect(await asEditorOn.ucpListPurchases!({ orgId: t.orgId })).toEqual({ purchases: [] });
    } finally {
      await saveConfig(d!, 'test');
    }
  });
});

describe('ADR 0875 D4 — a UCP client reaches only its own orders', () => {
  it('read / cancel of another buyer\'s order is the uniform 404; a deleted client\'s token dies', async () => {
    const t = await team();
    const p = await t.owner.post(c(t.orgId, '/products'), { type: 'digital', name: 'Course', price: 40, currency: 'USD' });
    const human = await t.owner.post(c(t.orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(human.status, JSON.stringify(human.body)).toBe(201);
    const prov = await t.owner.post(c(t.orgId, '/ucp/clients'), { name: 'agent' });
    expect(prov.status, JSON.stringify(prov.body)).toBe(201);
    const tok = await client().post(ucp(t.orgId, '/oauth/token'), { grant_type: 'client_credentials', client_id: prov.body.clientId, client_secret: prov.body.clientSecret });
    const bearer: string = tok.body.access_token;
    // RED on main: 200 with the human's order lines, and a cancel that succeeds.
    expect((await client().get(ucp(t.orgId, `/orders/${encodeURIComponent(human.body.orderId)}`), bearer)).status).toBe(404);
    expect((await client().post(ucp(t.orgId, `/orders/${encodeURIComponent(human.body.orderId)}/cancel`), {}, bearer)).status).toBe(404);
    // Its own order stays reachable.
    await client().post(ucp(t.orgId, '/cart/items'), { item_id: p.body.productId, quantity: 1 }, bearer);
    const own = await client().post(ucp(t.orgId, '/checkout'), {}, bearer);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect((await client().get(ucp(t.orgId, `/orders/${encodeURIComponent(own.body.id)}`), bearer)).status).toBe(200);
    // Revoking the client revokes its bearer immediately. DOUBLE GUARD (honest ceiling):
    // `deleteClient` purges the client's tokens AND `verifyToken` refuses a token whose
    // client is gone (ucpClientStore.ts), so removing either one alone keeps this 401.
    expect((await t.owner.del(c(t.orgId, `/ucp/clients/${encodeURIComponent(prov.body.clientId)}`))).status).toBeLessThan(300);
    expect((await client().get(ucp(t.orgId, `/orders/${encodeURIComponent(own.body.id)}`), bearer)).status).toBe(401);
  });
});

describe('ADR 0875 D7 — money input hygiene', () => {
  it('refuses fractional, zero and oversized quantities instead of pricing them', async () => {
    const t = await team();
    const p = await t.owner.post(c(t.orgId, '/products'), { type: 'digital', name: 'Licence', price: 100, currency: 'USD' });
    for (const quantity of [0.01, 1.5, 0, 10_001]) {
      const r = await client().post(pub(t.orgId, '/checkout'), { email: `fq-${n++}@x.test`, lines: [{ productId: p.body.productId, quantity }] });
      expect(r.status, `quantity ${quantity}: ${JSON.stringify(r.body)}`).toBe(400); // RED on main: 0.01 ⇒ 201, total 1
      expect(r.body.message).toBe('Each line quantity must be a whole number from 1 to 10000.');
    }
  });

  it('the public storefront does not sell an inactive product by id', async () => {
    const t = await team();
    const p = await t.owner.post(c(t.orgId, '/products'), { type: 'digital', name: 'Retired', price: 10, currency: 'USD' });
    const productId = p.body.productId;
    // Positive control: the product sells while active (the refusal below is the active flag).
    const live = await client().post(pub(t.orgId, '/checkout'), { email: `in-${n++}@x.test`, lines: [{ productId, quantity: 1 }] });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const off = await t.owner.patch(c(t.orgId, `/products/${encodeURIComponent(productId)}`), { active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.active).toBe(false); // the archive actually landed
    const r = await client().post(pub(t.orgId, '/checkout'), { email: `in-${n++}@x.test`, lines: [{ productId, quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    // Same text as a missing product (the wire redacts the id); the positive control and
    // the landed archive above are what make this the active-only refusal.
    expect(r.body.message).toMatch(/^Product not found: /);
  });

  it('prices are quantized to the currency minor unit', async () => {
    const t = await team();
    const p = await t.owner.post(c(t.orgId, '/products'), { type: 'digital', name: 'Odd', price: 0.125, currency: 'USD' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    // DOUBLE GUARD (honest ceiling): the price is quantized on WRITE (`createProduct`)
    // and again on every resolve (`pricing.ts` q()), so removing either alone keeps 13¢.
    expect(p.body.price).toBe(0.13);
    // Quantity 3, not 4: 4 × 0.125 = 0.5 is whole cents even unquantized.
    const o = await t.owner.post(c(t.orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 3 }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body.items[0]?.unitPrice).toBe(0.13);
    expect(o.body.total).toBe(0.39);
  });
});

describe('ADR 0875 D9 — payout CSV is not formula-injectable', () => {
  it('neutralises a leading = in an affiliate name', async () => {
    const t = await team();
    const a = await t.owner.post(c(t.orgId, '/affiliates'), { code: `CSV${n++}`, name: '=HYPERLINK("http://evil")', commissionType: 'percentage', commissionRate: 10, currency: 'USD' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const csv = await t.owner.get(c(t.orgId, '/affiliates/payouts.csv'));
    expect(csv.status).toBe(200);
    expect(csv.text).not.toMatch(/"=HYPERLINK/);
    // …and the name IS in the export, as a quoted, apostrophe-prefixed text cell.
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('ADR 0875 D6 — the merchant fetch dials through the pinned-resolution dispatcher', () => {
  it('passes webhookEgressDispatcher() on every hop', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/features/commerce/ucpBuyer/ucpBuyerService.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function merchantFetch'), src.indexOf('async function readBounded'));
    expect(body.length, 'merchantFetch located').toBeGreaterThan(200);
    expect(body).toMatch(/dispatcher:\s*webhookEgressDispatcher\(\)/);
  });
});
