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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';

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
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `fa-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '' };
}
const c = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('Group A — per-currency top products', () => {
  it('buckets top-product revenue per currency (single-currency revenue, own symbol)', async () => {
    const { owner, orgId } = await shopOwner();
    const usd = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'USD Item', price: 100, currency: 'USD' });
    const eur = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'EUR Item', price: 40, currency: 'EUR' });
    for (const p of [usd, usd, eur]) {
      const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
      await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    }
    const sum = (await owner.get(c(orgId, '/reports/summary'))).body;
    const byCcy = Object.fromEntries((sum.byCurrency as any[]).map((b) => [b.currency, b]));
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
    // Create a bespoke pipeline with a known stage.
    const pipe = await owner.post(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/pipelines`, { name: 'Commerce Wins', stages: [{ name: 'Closed Won', probability: 100 }] });
    const pipelineId = pipe.body.pipelineId;
    const stageId = pipe.body.stages[0].stageId;
    await setGovernancePolicy(tenantId, { commerce: { dealOnPaid: true, dealOnPaidPipelineId: pipelineId, dealOnPaidStageId: stageId } }, 'test');
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Buyer', email: `buy-${n++}@x.test` });
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 30, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    const deals = (await owner.get(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals`)).body.deals as any[];
    const linked = deals.filter((d) => d.contactId === contact.body.contactId);
    expect(linked).toHaveLength(1);
    expect(linked[0].pipelineId).toBe(pipelineId);
    expect(linked[0].stageId).toBe(stageId);
    expect(linked[0].status).toBe('won');
  });
});
