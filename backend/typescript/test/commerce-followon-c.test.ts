/**
 * Ecommerce follow-on Group C (ADR 0257) — typed product custom fields on the shared
 * host/customFields seam:
 *  - define product field defs (string/number/date/enum) + delete;
 *  - typed customFields round-trip through create/update + the public storefront;
 *  - validation: unknown key rejected, type mismatch rejected, required enforced.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { validateFieldValues, buildFieldSpec } from '../src/host/customFields/index.js';

// ── shared seam unit ─────────────────────────────────────────────────────────
describe('host/customFields seam', () => {
  it('validateFieldValues enforces type + required and rejects unknown keys', async () => {
    const defs = [
      { key: 'material', label: 'Material', type: 'string' as const, required: true },
      { key: 'weight', label: 'Weight', type: 'number' as const, required: false },
      { key: 'size', label: 'Size', type: 'enum' as const, required: false, options: ['S', 'M', 'L'] },
    ];
    expect(await validateFieldValues(defs, { material: 'cotton', weight: 5, size: 'M' }, { requireAll: true, entityLabel: 'product' }))
      .toEqual({ material: 'cotton', weight: 5, size: 'M' });
    await expect(validateFieldValues(defs, { weight: 'heavy' }, { requireAll: false, entityLabel: 'product' })).rejects.toThrow(); // type mismatch
    await expect(validateFieldValues(defs, { nope: 1 }, { requireAll: false, entityLabel: 'product' })).rejects.toThrow(); // unknown key
    await expect(validateFieldValues(defs, {}, { requireAll: true, entityLabel: 'product' })).rejects.toThrow(); // missing required
    await expect(validateFieldValues(defs, { size: 'XL' }, { requireAll: false, entityLabel: 'product' })).rejects.toThrow(); // enum out of range
  });
  it('buildFieldSpec rejects a reference field when no ref entities are allowed', () => {
    expect(() => buildFieldSpec({ key: 'ref', label: 'Ref', type: 'reference', refEntityType: 'product' }, [])).toThrow();
    expect(buildFieldSpec({ key: 'Fancy Key!', label: 'X', type: 'string' }).key).toBe('fancy_key_'); // key normalized
  });
});

// ── route round-trip ─────────────────────────────────────────────────────────
let BASE: string; let server: http.Server; let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `fc-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId };
}
const c = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('Group C — typed product custom fields (routes)', () => {
  it('defines fields, sets typed values on a product, and exposes them on the storefront', async () => {
    const { owner, orgId } = await shopOwner();
    expect((await owner.post(c(orgId, '/product-fields'), { key: 'material', label: 'Material', type: 'string', required: true })).status).toBe(201);
    await owner.post(c(orgId, '/product-fields'), { key: 'size', label: 'Size', type: 'enum', options: ['S', 'M', 'L'] });
    const fields = (await owner.get(c(orgId, '/product-fields'))).body.fields;
    expect(fields.map((f: any) => f.key).sort()).toEqual(['material', 'size']);

    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Tee', price: 20, currency: 'USD', inventory: 3, customFields: { material: 'cotton', size: 'M' } });
    expect(p.status).toBe(201);
    expect(p.body.customFields).toEqual({ material: 'cotton', size: 'M' });
    // Public storefront exposes them as LABEL-resolved pairs (shoppers see "Material", not the key).
    const pub = await owner.get(`/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
    const sp = (pub.body.products as any[]).find((x) => x.productId === p.body.productId);
    expect(sp.customFields).toEqual([{ label: 'Material', value: 'cotton' }, { label: 'Size', value: 'M' }]);
  });

  it('rejects an unknown key, a type mismatch, an out-of-range enum, and a missing required field', async () => {
    const { owner, orgId } = await shopOwner();
    await owner.post(c(orgId, '/product-fields'), { key: 'grams', label: 'Grams', type: 'number', required: true });
    await owner.post(c(orgId, '/product-fields'), { key: 'color', label: 'Color', type: 'enum', options: ['red', 'blue'] });
    const base = { type: 'physical', name: 'X', price: 1, currency: 'USD' };
    expect((await owner.post(c(orgId, '/products'), { ...base, customFields: { grams: 5, nope: 1 } })).status).toBe(400); // unknown key
    expect((await owner.post(c(orgId, '/products'), { ...base, customFields: { grams: 'heavy' } })).status).toBe(400); // type mismatch
    expect((await owner.post(c(orgId, '/products'), { ...base, customFields: { grams: 5, color: 'green' } })).status).toBe(400); // enum
    expect((await owner.post(c(orgId, '/products'), { ...base, customFields: {} })).status).toBe(400); // missing required
    expect((await owner.post(c(orgId, '/products'), { ...base, customFields: { grams: 5 } })).status).toBe(201); // ok
  });

  it('a patch replaces typed values (requireAll=false)', async () => {
    const { owner, orgId } = await shopOwner();
    await owner.post(c(orgId, '/product-fields'), { key: 'note', label: 'Note', type: 'string', required: false });
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'D', price: 5, currency: 'USD', customFields: { note: 'first' } });
    const up = await owner.patch(c(orgId, `/products/${encodeURIComponent(p.body.productId)}`), { customFields: { note: 'second' } });
    expect(up.body.customFields).toEqual({ note: 'second' });
  });
});
