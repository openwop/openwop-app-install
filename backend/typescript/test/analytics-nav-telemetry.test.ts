/**
 * Workspace navigation telemetry (ADR 0512) — route-level contract.
 * Asserts: DEFAULT OFF is a uniform 404 (the surface does not exist); the
 * ADR 0404 sub-toggle rule (parent `analytics` off ⇒ 404 even with the sub
 * on); closed source enum + route-pattern shape (invalid input DROPPED, 202
 * honesty, never stored); write-time AGGREGATION (same route+source twice ⇒
 * one row, count 2 — no per-event trail); the member-visible report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function memberClient(email: string): Promise<(m: string, p: string, b?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m2 = /(__session=[^;]+)/.exec(ck); if (m2) cookie = m2[1]; }
    return res;
  };
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email });
  expect(login.status).toBe(201);
  return call;
}

const setToggle = async (id: string, status: 'on' | 'off', salt: string): Promise<void> => {
  const r = await fetch(`${BASE}/v1/host/openwop-app/feature-toggles/admin/configs/${id}`, {
    method: 'PUT', headers: ADMIN, body: JSON.stringify({ status, bucketUnit: 'tenant', salt }),
  });
  expect(r.status, await r.text().catch(() => '')).toBeLessThan(300);
};

describe('workspace nav telemetry (ADR 0512)', () => {
  it('DEFAULT OFF: recording and reporting are a uniform 404', async () => {
    const call = await memberClient('nav-off@x.test');
    expect((await call('POST', '/v1/host/openwop-app/analytics/nav', { route: '/crm', source: 'sidebar' })).status).toBe(404);
    expect((await call('GET', '/v1/host/openwop-app/analytics/nav/report')).status).toBe(404);
  });

  it('sub ON but parent analytics OFF still 404s (the ADR 0404 AND rule)', async () => {
    await setToggle('workspace-nav-telemetry', 'on', 'workspace-nav-telemetry');
    await setToggle('analytics', 'off', 'analytics');
    const call = await memberClient('nav-parent-off@x.test');
    expect((await call('POST', '/v1/host/openwop-app/analytics/nav', { route: '/crm', source: 'sidebar' })).status).toBe(404);
    await setToggle('analytics', 'on', 'analytics'); // restore for the rest
  });

  it('aggregates at write time: two identical navs are ONE row with count 2; junk is dropped', async () => {
    const call = await memberClient('nav-agg@x.test');
    expect((await call('POST', '/v1/host/openwop-app/analytics/nav', { route: '/crm/deals/:dealId', source: 'palette' })).status).toBe(202);
    expect((await call('POST', '/v1/host/openwop-app/analytics/nav', { route: '/crm/deals/:dealId', source: 'palette' })).status).toBe(202);
    // closed enum: an unknown source is DROPPED (202, recorded:false), not stored
    const bad = await call('POST', '/v1/host/openwop-app/analytics/nav', { route: '/crm', source: 'heatmap' });
    expect(bad.status).toBe(202);
    expect(((await bad.json()) as { recorded: boolean }).recorded).toBe(false);
    // route shape: concrete junk with query strings / spaces is dropped
    const junk = await call('POST', '/v1/host/openwop-app/analytics/nav', { route: '/crm?x=SECRET value', source: 'sidebar' });
    expect(((await junk.json()) as { recorded: boolean }).recorded).toBe(false);

    const report = await call('GET', '/v1/host/openwop-app/analytics/nav/report');
    expect(report.status).toBe(200);
    const body = (await report.json()) as { rows: { route: string; source: string; count: number }[] };
    const row = body.rows.find((r) => r.route === '/crm/deals/:dealId' && r.source === 'palette');
    expect(row?.count).toBe(2);
    expect(body.rows.length).toBe(1); // the dropped inputs never became rows
  });

  it('tenants are isolated: another member sees their OWN empty report', async () => {
    const call = await memberClient('nav-other@x.test');
    const report = await call('GET', '/v1/host/openwop-app/analytics/nav/report');
    expect(report.status).toBe(200);
    expect(((await report.json()) as { rows: unknown[] }).rows).toEqual([]);
  });
});
