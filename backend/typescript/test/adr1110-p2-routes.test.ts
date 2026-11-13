/**
 * ADR 1110 P2 — the product routes read one page, never the whole catalog.
 *
 * Pins, through the HTTP boundary: the admin list pages with a cursor and reports the
 * catalog total; `?ids=` reads chosen products by id; type and state filter on the
 * server; the public storefront pages; the UCP catalog uses UCP's cursor-pagination
 * shape (`pagination: {has_next_page, cursor}`) and never lists an inactive product.
 */
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Product } from '../src/features/commerce/commerceService.js';
import type { UcpCatalogItem } from '../src/features/commerce/ucp/ucpAdapter.js';

function portOf(s: http.Server): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}
let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}
/** Login + org bodies (the test-auth and orgs routes). */
interface LoginBody extends ErrBody { user: { userId: string; tenantId: string } }
interface OrgBody extends ErrBody { orgId: string }
// An external UCP agent — no cookie, optional bearer.
async function pub<T = ErrBody>(method: string, path: string, body?: unknown, bearer?: string): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let out: T;
  try { out = JSON.parse(text || 'null'); } catch { out = JSON.parse('null'); } // the same single deserialization boundary as `client`
  return { status: res.status, body: out };
}
interface CatalogBody extends ErrBody { vertical: string; items: UcpCatalogItem[]; pagination: { has_next_page: boolean; cursor?: string } }
let n = 0;
const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function merchant(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:ucp-${Date.now()}-${n++}`;
  const owner = client(); await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'UCP Shop' });
  return { owner, orgId: org.body.orgId };
}
const ucp = (orgId: string, s = '') => `/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}${s}`;

interface PageBody extends ErrBody { products: Product[]; nextCursor?: string; total?: number }

async function seed(owner: Client, orgId: string): Promise<Product[]> {
  const base = `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`;
  const out: Product[] = [];
  for (const [name, type] of [['Alpha', 'physical'], ['Beta', 'digital'], ['Gamma', 'physical'], ['Delta', 'physical']] as const) {
    out.push((await owner.post<Product & ErrBody>(base, { type, name, price: 10, currency: 'USD', inventory: 5 })).body);
  }
  await owner.patch(`${base}/${encodeURIComponent(out[3]!.productId)}`, { active: false }); // Delta archived
  return out;
}

describe('ADR 1110 P2 — product routes page', () => {
  it('the admin list pages with a cursor, totals the catalog, reads by id and filters on the server', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await merchant();
    const made = await seed(owner, orgId);
    const base = `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products`;
    const first = await owner.get<PageBody>(`${base}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.products.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect(first.body.total).toBe(4);
    const second = await owner.get<PageBody>(`${base}?limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`);
    expect(second.body.products.map((p) => p.name)).toEqual(['Delta', 'Gamma']);
    expect(second.body.nextCursor).toBeUndefined();
    const byId = await owner.get<PageBody>(`${base}?ids=${encodeURIComponent(`${made[2]!.productId},${made[0]!.productId}`)}`);
    expect(byId.body.products.map((p) => p.name)).toEqual(['Gamma', 'Alpha']);
    expect((await owner.get<PageBody>(`${base}?type=digital`)).body.products.map((p) => p.name)).toEqual(['Beta']);
    expect((await owner.get<PageBody>(`${base}?state=archived`)).body.products.map((p) => p.name)).toEqual(['Delta']);
    expect((await owner.get<PageBody>(`${base}?q=gam`)).body.products.map((p) => p.name)).toEqual(['Gamma']);
  });

  it('the public storefront pages listed products only', async () => {
    await enable('commerce', 'on');
    const { owner, orgId } = await merchant();
    await seed(owner, orgId);
    const store = `/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`;
    const first = await pub<PageBody>('GET', `${store}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.products.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    const second = await pub<PageBody>('GET', `${store}?limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`);
    expect(second.body.products.map((p) => p.name)).toEqual(['Gamma']); // Delta is archived
  });

  it('the UCP catalog uses UCP cursor pagination', async () => {
    await enable('commerce', 'on'); await enable('commerce-ucp', 'on');
    const { owner, orgId } = await merchant();
    await seed(owner, orgId);
    const first = await pub<CatalogBody>('GET', `${ucp(orgId, '/catalog')}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((i) => i.title)).toEqual(['Alpha', 'Beta']);
    expect(first.body.pagination.has_next_page).toBe(true);
    const second = await pub<CatalogBody>('GET', `${ucp(orgId, '/catalog')}?limit=2&cursor=${encodeURIComponent(first.body.pagination.cursor ?? '')}`);
    expect(second.body.items.map((i) => i.title)).toEqual(['Gamma']);
    expect(second.body.pagination).toEqual({ has_next_page: false });
  });
});
