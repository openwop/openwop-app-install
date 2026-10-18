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
import type { Product } from '../src/features/commerce/commerceService.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { validateFieldValues, buildFieldSpec, type FieldSpec } from '../src/host/customFields/index.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}

// ── shared seam unit ─────────────────────────────────────────────────────────
describe('host/customFields seam', () => {
  it('validateFieldValues enforces type + required and rejects unknown keys', async () => {
    const defs: FieldSpec[] = [
      { key: 'material', label: 'Material', type: 'string', required: true },
      { key: 'weight', label: 'Weight', type: 'number', required: false },
      { key: 'size', label: 'Size', type: 'enum', required: false, options: ['S', 'M', 'L'] },
    ];
    expect(await validateFieldValues(defs, { material: 'cotton', weight: 5, size: 'M' }, { requireAll: true, entityLabel: 'product' }))
      .toEqual({ material: 'cotton', weight: 5, size: 'M' });
    // Each refusal asserts ITS message — a bare `toThrow()` is satisfied by any
    // guard, including one that fires for the wrong reason.
    await expect(validateFieldValues(defs, { weight: 'heavy' }, { requireAll: false, entityLabel: 'product' })).rejects.toThrow(/`weight` must be a number/);
    await expect(validateFieldValues(defs, { nope: 1 }, { requireAll: false, entityLabel: 'product' })).rejects.toThrow(/Unknown custom field `nope` for product/);
    await expect(validateFieldValues(defs, {}, { requireAll: true, entityLabel: 'product' })).rejects.toThrow(/`material` is required/);
    await expect(validateFieldValues(defs, { size: 'XL' }, { requireAll: false, entityLabel: 'product' })).rejects.toThrow(/`size` must be one of: S, M, L/);
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b), patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b), del: <T = unknown>(p: string) => call<T>('DELETE', p) };
}
interface LoginBody { user?: { userId: string; tenantId?: string }; tenantId?: string }
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `fc-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId };
}
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('Group C — typed product custom fields (routes)', () => {
  it('defines fields, sets typed values on a product, and exposes them on the storefront', async () => {
    const { owner, orgId } = await shopOwner();
    expect((await owner.post(c(orgId, '/product-fields'), { key: 'material', label: 'Material', type: 'string', required: true })).status).toBe(201);
    await owner.post(c(orgId, '/product-fields'), { key: 'size', label: 'Size', type: 'enum', options: ['S', 'M', 'L'] });
    const fields = (await owner.get<{ fields: FieldSpec[] }>(c(orgId, '/product-fields'))).body.fields;
    expect(fields.map((f) => f.key).sort()).toEqual(['material', 'size']);

    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'physical', name: 'Tee', price: 20, currency: 'USD', inventory: 3, customFields: { material: 'cotton', size: 'M' } });
    expect(p.status).toBe(201);
    expect(p.body.customFields).toEqual({ material: 'cotton', size: 'M' });
    // Public storefront exposes them as LABEL-resolved pairs (shoppers see "Material", not the key).
    const pub = await owner.get<{ products: Array<{ productId: string; customFields?: Array<{ label: string; value: unknown }> }> }>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`);
    const sp = pub.body.products.find((x) => x.productId === p.body.productId);
    expect(sp?.customFields).toEqual([{ label: 'Material', value: 'cotton' }, { label: 'Size', value: 'M' }]);
  });

  it('product create runs the org field defs: an unknown key is a typed 400, a valid map is 201', async () => {
    // WIRING witness only — the per-rule logic (type / enum / required / unknown)
    // is asserted with messages by the seam unit above, which goes red under the
    // same sabotage of each rule (measured), so it is not repeated here.
    const { owner, orgId } = await shopOwner();
    await owner.post(c(orgId, '/product-fields'), { key: 'grams', label: 'Grams', type: 'number', required: true });
    const base = { type: 'physical', name: 'X', price: 1, currency: 'USD' };
    const bad = await owner.post<ApiError>(c(orgId, '/products'), { ...base, customFields: { grams: 5, nope: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation_error');
    expect(bad.body.message).toMatch(/Unknown custom field `nope`/);
    const ok = await owner.post<Product>(c(orgId, '/products'), { ...base, customFields: { grams: 5 } });
    expect(ok.status).toBe(201);
    expect(ok.body.customFields).toEqual({ grams: 5 });
  });

  it('a patch replaces typed values (requireAll=false)', async () => {
    const { owner, orgId } = await shopOwner();
    await owner.post(c(orgId, '/product-fields'), { key: 'note', label: 'Note', type: 'string', required: false });
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'digital', name: 'D', price: 5, currency: 'USD', customFields: { note: 'first' } });
    const up = await owner.patch<Product>(c(orgId, `/products/${encodeURIComponent(p.body.productId)}`), { customFields: { note: 'second' } });
    expect(up.body.customFields).toEqual({ note: 'second' });
  });
});
