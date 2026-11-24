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
 *
 * Tracker TST-BUL-3. Sabotage-witnessed (w62): red when the superadmin check is
 * dropped, the per-feature tenant count stops counting tenants, the `day` format
 * check is skipped, or the rollup stops returning `managedByFeature`.
 *
 * Midnight-safe (2026-11-23): `DAY` used to be read at module load while the
 * rows were stamped with the clock in `beforeAll`, after the app boot (MEASURED
 * 2026-11-24: ~0.6 s later), so a run across 00:00 UTC asked for a day the rows
 * were not in. The rows are now stamped with one `AT` and `DAY` is derived from
 * it; the default-day case brackets the request with the day before and after
 * it; a fixed-day boundary case shows the explicit-day read never consults the
 * clock. Witnessed: the old file under a clock shift that puts 00:00 UTC in that
 * gap reddens 2 of 3 cases, and this file stays 4/4 under the same shift.
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
const utcDay = (d: Date) => d.toISOString().slice(0, 10);
// One instant for every row this file writes; set in beforeAll, read by every case.
let AT: Date;
let DAY = '';
// A fixed day, far from today, with a row stamped at its last millisecond.
const EDGE_DAY = '2026-01-01';
const EDGE_TENANT = 't-edge-0821';

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
  AT = new Date();
  DAY = utcDay(AT);
  await recordFeatureSpend({ tenantId: CUSTOMER, featureId: 'chat', inputTokens: 100, outputTokens: 40, at: AT });
  await recordFeatureSpend({ tenantId: CUSTOMER, featureId: 'chat-widget', inputTokens: 10, outputTokens: 5, at: AT });
  await recordFeatureSpend({ tenantId: OTHER, featureId: 'chat', inputTokens: 1, outputTokens: 1, at: AT });
  await recordFeatureSpend({ tenantId: EDGE_TENANT, featureId: 'cms', inputTokens: 7, outputTokens: 0, at: new Date(`${EDGE_DAY}T23:59:59.999Z`) });
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SUPERADMIN_TENANTS']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GET billing/admin/usage-by-feature — the operator read', () => {
  const path = (day?: string) => `/host/openwop-app/billing/admin/usage-by-feature${day ? `?day=${day}` : ''}`;

  it('refuses a customer (403) and serves the operator, with billing OFF', async () => {
    const refused = await get(customer, path(DAY));
    expect(refused.status).toBe(403);
    // The superadmin refusal, not the MFA one (same status): host/superadmin.ts.
    const refusal = await refused.json() as { error?: string; message?: string };
    expect(refusal.error).toBe('forbidden');
    expect(refusal.message).toContain('requires a superadmin principal');
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
    // "Today" is the server's clock at the request, so bracket the request: a run
    // across 00:00 UTC may see either side, never anything else.
    const before = utcDay(new Date());
    const served = ((await (await get(operator, path())).json()) as { day: string }).day;
    const after = utcDay(new Date());
    expect([before, after]).toContain(served);
    const bad = await get(operator, path('yesterday'));
    expect(bad.status).toBe(400);
    const badBody = await bad.json() as { error?: string; details?: { field?: string } };
    expect(badBody.error).toBe('validation_error');
    expect(badBody.details?.field).toBe('day');
  });

  it('an explicit day reads that UTC day\'s rows, whatever the clock says (the midnight boundary)', async () => {
    // The row was stamped at EDGE_DAY's last millisecond: it belongs to EDGE_DAY,
    // not the next day, and a read for either day is decided by `day`, not by now.
    const edge = await (await get(operator, path(EDGE_DAY))).json() as { day: string; features: Array<{ featureId: string; tenants: number; inputTokens: number }> };
    expect(edge.day).toBe(EDGE_DAY);
    expect(edge.features).toEqual([expect.objectContaining({ featureId: 'cms', tenants: 1, inputTokens: 7 })]);
    const next = await (await get(operator, path('2026-01-02'))).json() as { day: string; features: unknown[] };
    expect(next.day).toBe('2026-01-02');
    expect(next.features).toEqual([]);
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
