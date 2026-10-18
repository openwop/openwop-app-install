/**
 * CDP-C — audience insights (ADR 0265). Read-time projections over live segment
 * membership: estimate (size), insights (stage mix / reachability / avg propensity),
 * and overlap between two segments.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { SegmentInsights } from '../src/features/crm/segmentsService.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T,>(m: string, p: string, b?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { get: <T,>(p: string) => call<T>('GET', p), post: <T,>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
let n = 0;
async function owner() { const c = client(); const r = await c.post('/host/openwop-app/test/login', { email: `ai-${Date.now()}-${n++}@a.test`, tenantId: `org:ai-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

describe('CDP-C audience insights', () => {
  it('estimate, insights, and overlap over live membership', async () => {
    await enable('crm');
    const c = await owner();
    const mk = async (body: Record<string, string>): Promise<void> => { expect((await c.post('/host/openwop-app/crm/contacts', body)).status).toBe(201); };
    await mk({ name: 'C1', email: 'c1@x.test', stage: 'customer' });
    await mk({ name: 'C2', email: 'c2@x.test', stage: 'customer' });
    await mk({ name: 'C3', stage: 'customer' }); // a customer with NO email — reachability must not count it
    await mk({ name: 'L1', stage: 'lead' }); // no email

    const seg = async (name: string, filters: unknown[]): Promise<string> => {
      const r = await c.post<{ segmentId: string }>('/host/openwop-app/crm/segments', { name, filters });
      expect(r.status).toBe(201);
      return r.body.segmentId;
    };
    const customers = await seg('customers', [{ field: 'stage', op: 'eq', value: 'customer' }]);
    const leads = await seg('leads', [{ field: 'stage', op: 'eq', value: 'lead' }]);
    const all = await seg('all', []);

    const est = await c.get<{ size: number }>(`/host/openwop-app/crm/segments/${customers}/estimate`);
    expect(est.body.size).toBe(3);

    const ins = (await c.get<SegmentInsights>(`/host/openwop-app/crm/segments/${customers}/insights`)).body;
    expect(ins.size).toBe(3);
    expect(ins.byStage).toEqual({ customer: 3 });
    expect(ins.withEmail).toBe(2);
    // avgPropensity is a real per-member average: customers (stage score + an email
    // identifier) outrank a lone email-less lead. An ordering, not a re-computation.
    const leadIns = (await c.get<SegmentInsights>(`/host/openwop-app/crm/segments/${leads}/insights`)).body;
    expect(ins.avgPropensity).toBeGreaterThan(leadIns.avgPropensity);
    expect(Number(ins.avgPropensity.toFixed(2))).toBe(ins.avgPropensity); // rounded to 2 dp

    const overlap = await c.get(`/host/openwop-app/crm/segments-overlap?a=${customers}&b=${all}`);
    expect(overlap.body).toEqual({ sizeA: 3, sizeB: 4, intersection: 3 });
  });
});
