/**
 * Ecommerce follow-on Group A (ADR 0239/0240 correction-notes):
 *  - per-currency top products: byCurrency[].topProducts carries single-currency
 *    revenue (no more cross-currency sum under one symbol);
 *  - configurable Deal-on-paid pipeline/stage: the won Deal lands on the operator's
 *    chosen pipeline+stage, not just the default.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import type { Product, Order, CommerceSummary } from '../src/features/commerce/commerceService.js';
import type { Contact } from '../src/features/crm/contactsService.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { getOrCreateDefaultPipeline, type Pipeline } from '../src/features/crm/entities/pipelines.js';
import type { Deal } from '../src/features/crm/entities/deals.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
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

/** The ONE untyped boundary: `JSON.parse` returns the declared `T` (the call
 *  site's statement of the shape it reads). An empty or non-JSON body is `null`. */
function parseBody<T>(text: string): T {
  try { return JSON.parse(text === '' ? 'null' : text); } catch { return JSON.parse('null'); }
}
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
interface LoginBody { user?: { userId: string; tenantId?: string }; tenantId?: string }
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `fa-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '' };
}
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('Group A — per-currency top products', () => {
  it('buckets top-product revenue per currency (single-currency revenue, own symbol)', async () => {
    const { owner, orgId } = await shopOwner();
    const usd = await owner.post<Product>(c(orgId, '/products'), { type: 'digital', name: 'USD Item', price: 100, currency: 'USD' });
    const eur = await owner.post<Product>(c(orgId, '/products'), { type: 'digital', name: 'EUR Item', price: 40, currency: 'EUR' });
    for (const p of [usd, usd, eur]) {
      const o = await owner.post<Order>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
      await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    }
    const sum = (await owner.get<CommerceSummary>(c(orgId, '/reports/summary'))).body;
    const byCcy = Object.fromEntries(sum.byCurrency.map((b) => [b.currency, b]));
    expect(byCcy.USD.topProducts[0].revenue).toBe(200); // 2 × $100, NOT mixed with EUR
    expect(byCcy.EUR.topProducts[0].revenue).toBe(40);
    // The flat headline mirrors the primary (USD) currency's list.
    expect(sum.topProducts[0].name).toBe('USD Item');
    expect(sum.topProducts[0].revenue).toBe(200);
  });
});

describe('Group A — configurable Deal-on-paid pipeline', () => {
  it('lands the won Deal on the operator-configured pipeline + stage', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    // The configured pipeline must NOT be the org default: `createDeal` falls back
    // to the org's first pipeline, so a bespoke pipeline that is the org's only one
    // IS the default and dropping the configured id lands the deal in the same
    // place (measured: both probes were vacuous). Two candidate pipelines are made
    // and the one the fallback does NOT pick is the target (the index order is not
    // guaranteed, so the choice is read, never assumed). The target stage is the
    // SECOND one — the fallback stage is index 0.
    const mk = async (name: string): Promise<{ pipelineId: string; stages: Array<{ stageId: string }> }> =>
      (await owner.post<Pipeline>(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/pipelines`, { name, stages: [{ name: 'Qualified', probability: 50 }, { name: 'Closed Won', probability: 100 }] })).body;
    const candidates = [await mk('Commerce Wins A'), await mk('Commerce Wins B')];
    const fallbackId = (await getOrCreateDefaultPipeline(tenantId, orgId)).pipelineId;
    const target = candidates.find((x) => x.pipelineId !== fallbackId)!;
    const pipelineId = target.pipelineId;
    const stageId = target.stages[1].stageId;
    expect(pipelineId).not.toBe(fallbackId); // positive control: the fixture discriminates
    await setGovernancePolicy(tenantId, { commerce: { dealOnPaid: true, dealOnPaidPipelineId: pipelineId, dealOnPaidStageId: stageId } }, 'test');
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Buyer', email: `buy-${n++}@x.test` });
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 30, currency: 'USD' });
    const o = await owner.post<Order>(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post<Order>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    const deals = (await owner.get<{ deals: Deal[] }>(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals`)).body.deals;
    const linked = deals.filter((d) => d.contactId === contact.body.contactId);
    expect(linked).toHaveLength(1);
    expect(linked[0].pipelineId).toBe(pipelineId);
    expect(linked[0].stageId).toBe(stageId);
    expect(linked[0].status).toBe('won');
  });
});
