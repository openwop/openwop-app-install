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

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `ai-${Date.now()}-${n++}@a.test`, tenantId: `org:ai-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

describe('CDP-C audience insights', () => {
  it('estimate, insights, and overlap over live membership', async () => {
    await enable('crm');
    const c = await owner();
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'C1', email: 'c1@x.test', stage: 'customer' });
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'C2', email: 'c2@x.test', stage: 'customer' });
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'L1', stage: 'lead' }); // no email

    const customers = (await c.post('/v1/host/openwop-app/crm/segments', { name: 'customers', filters: [{ field: 'stage', op: 'eq', value: 'customer' }] })).body;
    const all = (await c.post('/v1/host/openwop-app/crm/segments', { name: 'all', filters: [] })).body;

    const est = await c.get(`/v1/host/openwop-app/crm/segments/${customers.segmentId}/estimate`);
    expect(est.body.size).toBe(2);

    const ins = await c.get(`/v1/host/openwop-app/crm/segments/${customers.segmentId}/insights`);
    expect(ins.body.size).toBe(2);
    expect(ins.body.byStage.customer).toBe(2);
    expect(ins.body.withEmail).toBe(2);
    expect(ins.body.avgPropensity).toBeGreaterThan(0);

    const overlap = await c.get(`/v1/host/openwop-app/crm/segments-overlap?a=${customers.segmentId}&b=${all.segmentId}`);
    expect(overlap.body).toEqual({ sizeA: 2, sizeB: 3, intersection: 2 });
  });
});
