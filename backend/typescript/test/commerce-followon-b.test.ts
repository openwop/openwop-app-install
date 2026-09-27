/**
 * Ecommerce follow-on Group B (ADR 0250) — tax/shipping depth:
 *  - Product parcel model (weightGrams) round-trips;
 *  - no shipping connection ⇒ flat governance rate (best-effort fallback);
 *  - a configured Shippo connection + shipFrom + weighed cart ⇒ the CHEAPEST live
 *    carrier rate is billed (mock carrier via OPENWOP_COMMERCE_PROVIDER_BASE);
 *  - a carrier error ⇒ flat fallback (never blocks the sale).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';

let BASE: string; let server: http.Server; let n = 0;
let carrier: http.Server; let CARRIER_URL = ''; let carrierMode: 'ok' | 'error' | 'foreign' = 'ok';
// captured for the auth-header + unit assertions
let easypostReq: { auth?: string; body?: { shipment?: { parcel?: { weight?: number }; from_address?: { zip?: string } } } } = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes')); // signed-in secrets need KMS
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'connections']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  // Mock carrier — POST /v1/shipments returns two rates (cheapest = 5.25).
  carrier = http.createServer((req, res) => {
    if (req.url === '/v1/shipments' && req.method === 'POST') { // Shippo shape: rates[].amount
      if (carrierMode === 'error') { res.writeHead(500).end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      const rates = carrierMode === 'foreign'
        ? [{ amount: '3.00', currency: 'EUR' }] // wrong currency for a USD order
        : [{ amount: '7.50', currency: 'USD' }, { amount: '5.25', currency: 'USD' }];
      res.end(JSON.stringify({ rates }));
      return;
    }
    if (req.url === '/v2/shipments' && req.method === 'POST') { // EasyPost shape: rates[].rate (string)
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', () => {
        easypostReq = { auth: req.headers.authorization, body: JSON.parse(raw || '{}') };
        if (carrierMode === 'error') { res.writeHead(500).end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        const rates = carrierMode === 'foreign'
          ? [{ rate: '3.00', currency: 'EUR' }]
          : [{ rate: '7.50', currency: 'USD' }, { rate: '5.25', currency: 'USD' }];
        res.end(JSON.stringify({ rates })); // the POST returns the shipment object with rates auto-populated
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((res) => { carrier.listen(0, '127.0.0.1', () => { CARRIER_URL = `http://127.0.0.1:${(carrier.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_PROVIDER_BASE;
  await new Promise<void>((res) => carrier.close(() => res()));
  await new Promise<void>((res) => server.close(() => res()));
});
afterEach(() => { delete process.env.OPENWOP_COMMERCE_PROVIDER_BASE; carrierMode = 'ok'; });

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
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `fb-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '' };
}
const c = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;
const SHIP_TO = { line1: '1 Main', city: 'Town', region: 'CA', postalCode: '94016', country: 'US' };

describe('Group B — parcel model + shipping depth', () => {
  it('round-trips a product shipping weight', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Boxed', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    expect(p.status).toBe(201);
    expect(p.body.weightGrams).toBe(500);
    const got = (await owner.get(c(orgId, `/products?q=Boxed`))).body.products[0];
    expect(got.weightGrams).toBe(500);
  });

  it('no shipping connection ⇒ the flat governance rate', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800 } }, 'test'); // $8 flat
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Flat', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.body.shippingCost).toBe(8); // flat, no carrier configured
  });

  it('a configured carrier + shipFrom + weighed cart ⇒ the cheapest live rate', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const conn = await owner.post('/v1/host/openwop-app/connections', { provider: 'shippo', kind: 'api_key', secret: 'shippo-test-key', scope: 'user', displayName: 'Shippo' });
    expect(conn.status).toBe(201);
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US', region: 'NY' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Rated', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.body.shippingCost).toBe(5.25); // cheapest of {7.50, 5.25}, NOT the $8 flat
  });

  it('a carrier error falls back to the flat rate (never blocks the sale)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await owner.post('/v1/host/openwop-app/connections', { provider: 'shippo', kind: 'api_key', secret: 'shippo-test-key', scope: 'user', displayName: 'Shippo' });
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    carrierMode = 'error';
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Errd', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.status).toBe(201);
    expect(o.body.shippingCost).toBe(8); // fell back to flat
  });

  it('ignores carrier rates in a DIFFERENT currency than the order (never mis-bills)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await owner.post('/v1/host/openwop-app/connections', { provider: 'shippo', kind: 'api_key', secret: 'shippo-test-key', scope: 'user', displayName: 'Shippo' });
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    carrierMode = 'foreign'; // carrier returns EUR rates
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Fx', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.body.shippingCost).toBe(8); // NOT 3.00 EUR — fell back to the USD flat rate
  });

  it('EasyPost mapper: cheapest rate billed, Basic auth (trailing colon), grams→ounces', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    // ONLY an easypost connection (no shippo) — else the shippo→easypost cascade would pick shippo.
    const conn = await owner.post('/v1/host/openwop-app/connections', { provider: 'easypost', kind: 'api_key', secret: 'easypost-test-key', scope: 'user', displayName: 'EasyPost' });
    expect(conn.status).toBe(201);
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US', region: 'NY' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    easypostReq = {};
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'EPRated', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.body.shippingCost).toBe(5.25); // cheapest of {7.50, 5.25}, over EasyPost's `rate` field
    // Basic auth with the API key as username + empty password (the REQUIRED trailing colon).
    expect(easypostReq.auth).toBe(`Basic ${Buffer.from('easypost-test-key:').toString('base64')}`);
    // Our model stores grams; EasyPost parcels are OUNCES → 500 g / 28.3495 = 17.6 oz.
    expect(easypostReq.body?.shipment?.parcel?.weight).toBe(17.6);
    expect(easypostReq.body?.shipment?.from_address?.zip).toBe('10001'); // origin threaded from governance shipFrom
  });

  it('an EasyPost carrier error falls back to the flat rate (never blocks the sale)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await owner.post('/v1/host/openwop-app/connections', { provider: 'easypost', kind: 'api_key', secret: 'easypost-test-key', scope: 'user', displayName: 'EasyPost' });
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    carrierMode = 'error'; // EasyPost /v2/shipments returns 500 ⇒ postJson null ⇒ flat
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'EPErr', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.status).toBe(201);
    expect(o.body.shippingCost).toBe(8); // fell back to flat, sale not blocked
  });

  it('EasyPost foreign-currency rates ⇒ flat fallback (never mis-bills)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await owner.post('/v1/host/openwop-app/connections', { provider: 'easypost', kind: 'api_key', secret: 'easypost-test-key', scope: 'user', displayName: 'EasyPost' });
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    carrierMode = 'foreign';
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'EPFx', price: 20, currency: 'USD', inventory: 5, weightGrams: 500 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.body.shippingCost).toBe(8); // EUR rate ignored ⇒ USD flat
  });

  it('an unweighed physical line ⇒ no rate-shopping (flat)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await owner.post('/v1/host/openwop-app/connections', { provider: 'shippo', kind: 'api_key', secret: 'shippo-test-key', scope: 'user', displayName: 'Shippo' });
    await setGovernancePolicy(tenantId, { commerce: { flatShippingMinor: 800, shipFrom: { postalCode: '10001', country: 'US' } } }, 'test');
    process.env.OPENWOP_COMMERCE_PROVIDER_BASE = CARRIER_URL;
    const weighed = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'W', price: 10, currency: 'USD', inventory: 5, weightGrams: 200 });
    const noweight = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'NW', price: 10, currency: 'USD', inventory: 5 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: weighed.body.productId, quantity: 1 }, { productId: noweight.body.productId, quantity: 1 }], shippingAddress: SHIP_TO });
    expect(o.body.shippingCost).toBe(8); // one line unweighed ⇒ flat, not a live rate
  });
});
