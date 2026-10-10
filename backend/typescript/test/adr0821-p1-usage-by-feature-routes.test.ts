/**
 * ADR 0821 D4 / P1 — the two READS of the per-feature managed-spend store.
 *
 *   - `GET …/billing/admin/usage-by-feature?day=` — the operator's cross-tenant
 *     read. Superadmin only (a customer is refused: the positive control is the
 *     operator served on the same rows), and NOT gated on the billing toggle,
 *     because P1 exists to measure spend before pricing is switched on.
 *   - `GET …/usage/orgs/:orgId/rollup` — usage-analytics now returns the
 *     tenant's managed (platform-paid) spend beside the BYOK rollup, and only
 *     that tenant's.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { recordFeatureSpend } from '../src/host/managedCredits.js';

let server: http.Server;
let BASE: string;
const OPERATOR = 'user:op-0821';
const CUSTOMER = 't-cust-0821';
const OTHER = 't-other-0821';
const DAY = new Date().toISOString().slice(0, 10);

async function login(email: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, tenantId }),
  });
  const h = res.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) return m[1]!;
  }
  throw new Error(`login for ${tenantId} set no session cookie (${res.status})`);
}
const get = (cookie: string, path: string) => fetch(`${BASE}${path}`, { headers: { cookie } });

let operator = '';
let customer = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // billing deliberately left at its default (OFF): the operator read must not need it.
  for (const id of ['users', 'usage-analytics']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  operator = await login('op@host.test', OPERATOR);
  customer = await login('cust@acme.test', CUSTOMER);
  await recordFeatureSpend({ tenantId: CUSTOMER, featureId: 'chat', inputTokens: 100, outputTokens: 40 });
  await recordFeatureSpend({ tenantId: CUSTOMER, featureId: 'chat-widget', inputTokens: 10, outputTokens: 5 });
  await recordFeatureSpend({ tenantId: OTHER, featureId: 'chat', inputTokens: 1, outputTokens: 1 });
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SUPERADMIN_TENANTS']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GET billing/admin/usage-by-feature — the operator read', () => {
  const path = (day?: string) => `/host/openwop-app/billing/admin/usage-by-feature${day ? `?day=${day}` : ''}`;

  it('refuses a customer (403) and serves the operator, with billing OFF', async () => {
    expect((await get(customer, path(DAY))).status).toBe(403);
    const res = await get(operator, path(DAY));
    expect(res.status).toBe(200);
    const body = await res.json() as { day: string; features: Array<{ featureId: string; tenants: number; inputTokens: number }>; rows: unknown[] };
    expect(body.day).toBe(DAY);
    const chat = body.features.find((f) => f.featureId === 'chat')!;
    expect(chat.tenants).toBe(2); // CUSTOMER + OTHER, cross-tenant by design
    expect(chat.inputTokens).toBe(101);
    expect(body.features.find((f) => f.featureId === 'chat-widget')?.inputTokens).toBe(10);
  });

  it('defaults to today, and rejects a malformed day', async () => {
    expect(((await (await get(operator, path())).json()) as { day: string }).day).toBe(DAY);
    expect((await get(operator, path('yesterday'))).status).toBe(400);
  });
});

describe('GET usage/orgs/:orgId/rollup — usage-analytics sees managed spend', () => {
  it('returns the caller tenant\'s managed per-feature rows beside the BYOK rollup, and no other tenant\'s', async () => {
    const made = await fetch(`${BASE}/host/openwop-app/orgs`, { method: 'POST', headers: { cookie: customer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Acme' }) });
    const { orgId } = await made.json() as { orgId: string };
    const res = await get(customer, `/host/openwop-app/usage/orgs/${orgId}/rollup`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rollup: unknown[]; managedByFeature: Array<{ tenantId: string; featureId: string }>; managedWindowDays: number };
    expect(Array.isArray(body.rollup)).toBe(true);
    expect(body.managedWindowDays).toBe(30);
    expect(body.managedByFeature.map((r) => r.featureId).sort()).toEqual(['chat', 'chat-widget']);
    expect(body.managedByFeature.every((r) => r.tenantId === CUSTOMER)).toBe(true);
  });
});
