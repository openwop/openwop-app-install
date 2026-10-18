/**
 * ADR 0240 — Phase 3 commerce deferrals:
 *  - DEF-2 AP2 VC signing: a configured Ed25519 key produces a verifiable proof;
 *    a tampered mandate fails verification; no key ⇒ the honest unsigned warning;
 *  - DEF-4 product attributes: bounded {label,value} pairs round-trip through the
 *    admin + public storefront; blanks/dupes/over-cap dropped;
 *  - DEF-8 Deal-on-paid: opt-in ⇒ a paid order with a contact opens ONE won Deal;
 *    opt-out (default, and explicit `dealOnPaid:false`) ⇒ no Deal. (The deterministic
 *    per-order dealId is not testable through the route — a re-delivered pay returns
 *    before the Deal block — so it is a ceiling, not a claim here.)
 */
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import type { Product, Order } from '../src/features/commerce/commerceService.js';
import type { Contact } from '../src/features/crm/contactsService.js';
import type { Deal } from '../src/features/crm/entities/deals.js';
import { buildCartMandate, buildPaymentMandate, signPaymentMandate, verifyPaymentMandate } from '../src/features/commerce/ucpBuyer/ap2Mandates.js';

// ── DEF-2: pure unit (no server) ─────────────────────────────────────────────
describe('DEF-2 — AP2 verifiable-credential signing', () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const mandate = () => {
    const { cart } = buildCartMandate({ intent: 'buy coffee', maxAmountMinor: 5000, merchantUrl: 'https://m.test', currency: 'USD', lines: [{ externalProductId: 'x', name: 'Coffee', quantity: 1, unitPriceMinor: 1200 }], now: '2026-01-01T00:00:00.000Z' });
    return buildPaymentMandate(cart, 'appr:1', '2026-01-01T00:00:00.000Z');
  };
  it('signs with a configured key and verifies', () => {
    const signed = signPaymentMandate(mandate(), { privateKeyPem: pem });
    expect(signed.proof).toBeDefined();
    expect(signed.warnings).toHaveLength(0);
    expect(verifyPaymentMandate(signed)).toBe(true);
  });
  it('fails verification when the mandate is tampered after signing', () => {
    const signed = signPaymentMandate(mandate(), { privateKeyPem: pem });
    const tampered = { ...signed, totalMinor: signed.totalMinor + 1 };
    expect(verifyPaymentMandate(tampered)).toBe(false);
  });
  it('leaves the honest unsigned warning when no key is configured', () => {
    // signPaymentMandate falls back to OPENWOP_AP2_SIGNING_KEY — clear it so an operator
    // or CI env cannot sign this "no key" case.
    const prior = process.env.OPENWOP_AP2_SIGNING_KEY;
    delete process.env.OPENWOP_AP2_SIGNING_KEY;
    try {
      const unsigned = signPaymentMandate(mandate(), {});
      expect(unsigned.proof).toBeUndefined();
      expect(unsigned.warnings[0]).toMatch(/not_configured/);
    } finally {
      if (prior !== undefined) process.env.OPENWOP_AP2_SIGNING_KEY = prior;
    }
  });
  it('does not throw on a bad key — records a failure warning instead', () => {
    const bad = signPaymentMandate(mandate(), { privateKeyPem: 'not-a-key' });
    expect(bad.proof).toBeUndefined();
    expect(bad.warnings.some((w) => /vc_signing_failed/.test(w))).toBe(true);
  });
});

// ── DEF-4/DEF-8: route round-trip ────────────────────────────────────────────
function portOf(s: http.Server): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}
let BASE: string; let server: http.Server; let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
/** Login + org bodies (the test-auth and orgs routes). */
interface LoginBody extends ErrBody { user: { userId: string; tenantId: string } }
interface OrgBody extends ErrBody { orgId: string }
async function shopOwner(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `p3-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user.tenantId };
}
/** The public storefront's product projection (commerce/routes.ts — no inventory/cost). */
interface PublicProductBody { productId: string; name: string; attributes?: { label: string; value: string }[] }
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('DEF-4 — product attributes', () => {
  it('round-trips bounded attributes through admin + public storefront; drops blanks/dupes', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), {
      type: 'physical', name: 'Tee', price: 20, currency: 'USD', inventory: 3,
      attributes: [
        { label: 'Material', value: 'Cotton' },
        { label: 'material', value: 'dupe-label' }, // dedup on label (case-insensitive)
        { label: '', value: 'no-label' },            // dropped
        { label: 'Fit', value: '' },                 // dropped
        { label: 'Origin', value: 'Portugal' },
      ],
    });
    expect(p.status).toBe(201);
    expect(p.body.attributes).toEqual([{ label: 'Material', value: 'Cotton' }, { label: 'Origin', value: 'Portugal' }]);
    // Public storefront exposes them.
    const pub = await owner.get<{ products: PublicProductBody[] }>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
    const sp = pub.body.products.find((x) => x.productId === p.body.productId)!;
    expect(sp.attributes).toEqual([{ label: 'Material', value: 'Cotton' }, { label: 'Origin', value: 'Portugal' }]);
  });

  it('caps attributes at 20 (the rest are dropped, never stored)', async () => {
    const { owner, orgId } = await shopOwner();
    const attributes = Array.from({ length: 22 }, (_, i) => ({ label: `Label ${i}`, value: `Value ${i}` }));
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'digital', name: 'Many', price: 1, currency: 'USD', attributes });
    expect(p.status).toBe(201);
    const stored = await owner.get<Product>(c(orgId, `/products/${encodeURIComponent(p.body.productId)}`));
    expect(stored.body.attributes).toHaveLength(20);
    expect(stored.body.attributes?.[19]).toEqual({ label: 'Label 19', value: 'Value 19' });
  });
});

describe('DEF-8 — Deal-on-paid (opt-in)', () => {
  const deals = (orgId: string): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals`;
  it('opt-in ⇒ a paid order with a contact opens exactly one won Deal', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { dealOnPaid: true } }, 'test');
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Buyer', email: `b-${n++}@x.test` });
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 40, currency: 'USD' });
    const o = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    const list = await owner.get<{ deals: Deal[] }>(deals(orgId));
    const linked = list.body.deals.filter((d) => d.contactId === contact.body.contactId);
    expect(linked).toHaveLength(1);
    expect(linked[0].status).toBe('won');
    expect(linked[0].amount).toBe(40);
  });
  it('opt-out (default) ⇒ no Deal is created', async () => {
    const { owner, orgId } = await shopOwner();
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Buyer2', email: `b2-${n++}@x.test` });
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'digital', name: 'Guide2', price: 15, currency: 'USD' });
    const o = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    const list = await owner.get<{ deals: Deal[] }>(deals(orgId));
    expect(list.body.deals.filter((d) => d.contactId === contact.body.contactId)).toHaveLength(0);
  });
  it('explicit opt-out (dealOnPaid:false) ⇒ no Deal is created', async () => {
    // The default case above has NO commerce policy at all; this one has a policy that
    // says false, so the gate itself — not an absent policy — is what declines.
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { dealOnPaid: false } }, 'test');
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Buyer3', email: `b3-${n++}@x.test` });
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'digital', name: 'Guide3', price: 15, currency: 'USD' });
    const o = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    const paid = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    expect(paid.body.status).toBe('paid');
    const list = await owner.get<{ deals: Deal[] }>(deals(orgId));
    expect(list.body.deals.filter((d) => d.contactId === contact.body.contactId)).toHaveLength(0);
  });
});
