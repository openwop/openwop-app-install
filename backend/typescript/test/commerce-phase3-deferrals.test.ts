/**
 * ADR 0240 — Phase 3 commerce deferrals:
 *  - DEF-2 AP2 VC signing: a configured Ed25519 key produces a verifiable proof;
 *    a tampered mandate fails verification; no key ⇒ the honest unsigned warning;
 *  - DEF-4 product attributes: bounded {label,value} pairs round-trip through the
 *    admin + public storefront; blanks/dupes/over-cap dropped;
 *  - DEF-8 Deal-on-paid: opt-in ⇒ a paid order with a contact opens ONE won Deal
 *    (idempotent by orderId); opt-out ⇒ no Deal.
 */
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
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
    const unsigned = signPaymentMandate(mandate(), {});
    expect(unsigned.proof).toBeUndefined();
    expect(unsigned.warnings[0]).toMatch(/not_configured/);
  });
  it('does not throw on a bad key — records a failure warning instead', () => {
    const bad = signPaymentMandate(mandate(), { privateKeyPem: 'not-a-key' });
    expect(bad.proof).toBeUndefined();
    expect(bad.warnings.some((w) => /vc_signing_failed/.test(w))).toBe(true);
  });
});

// ── DEF-4/DEF-8: route round-trip ────────────────────────────────────────────
let BASE: string; let server: http.Server; let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `p3-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '' };
}
const c = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('DEF-4 — product attributes', () => {
  it('round-trips bounded attributes through admin + public storefront; drops blanks/dupes', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), {
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
    const pub = await owner.get(`/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
    const sp = (pub.body.products as any[]).find((x) => x.productId === p.body.productId);
    expect(sp.attributes).toEqual([{ label: 'Material', value: 'Cotton' }, { label: 'Origin', value: 'Portugal' }]);
  });
});

describe('DEF-8 — Deal-on-paid (opt-in)', () => {
  const deals = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals`;
  it('opt-in ⇒ a paid order with a contact opens exactly one won Deal', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { dealOnPaid: true } }, 'test');
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Buyer', email: `b-${n++}@x.test` });
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 40, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    const list = await owner.get(deals(orgId));
    const linked = (list.body.deals as any[]).filter((d) => d.contactId === contact.body.contactId);
    expect(linked).toHaveLength(1);
    expect(linked[0].status).toBe('won');
    expect(linked[0].amount).toBe(40);
  });
  it('opt-out (default) ⇒ no Deal is created', async () => {
    const { owner, orgId } = await shopOwner();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Buyer2', email: `b2-${n++}@x.test` });
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Guide2', price: 15, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    const list = await owner.get(deals(orgId));
    expect((list.body.deals as any[]).filter((d) => d.contactId === contact.body.contactId)).toHaveLength(0);
  });
});
