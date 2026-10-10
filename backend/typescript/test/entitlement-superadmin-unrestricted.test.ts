/**
 * ADR 0419 correction (2026-10-01) — the host's OPERATOR is not paywalled.
 *
 * The plan paywall sells features to customers. On production the operator —
 * the one tenant in OPENWOP_SUPERADMIN_TENANTS — typed `@@` and was told "Your
 * plan (free) does not include this feature", because the entitlement gate
 * asked only what the tenant had bought.
 *
 * Proved at the route (the gate is only observable there), with a second tenant
 * as the control: the SAME narrowed plan still 403s an ordinary tenant, and the
 * dev-open switch — which makes every caller a superadmin for admin surfaces —
 * does NOT un-paywall anyone.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetBilling, resolveEntitlements } from '../src/features/billing/billingService.js';
import { isListedSuperadminTenant } from '../src/host/superadmin.js';

let server: http.Server;
let BASE: string;
const OPERATOR = 'user:operator-0001';
const CUSTOMER = 't-customer';

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
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_mktg: 'marketing' });
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'webinars']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  operator = await login('operator@host.test', OPERATOR);
  customer = await login('customer@acme.test', CUSTOMER);
});
afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_PLAN_FEATURES', 'OPENWOP_FEATURE_TOGGLES_DEV_OPEN']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); });

/** A Marketing-bundle route with no per-feature entitlement code — it gates
 *  purely through the central seam (the `entitlement-central-gate` precedent). */
async function webinars(cookie: string): Promise<number> {
  const made = await fetch(`${BASE}/host/openwop-app/orgs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Acme' }) });
  const { orgId } = await made.json() as { orgId: string };
  return (await get(cookie, `/host/openwop-app/webinars/orgs/${orgId}/events`)).status;
}
const ENTITLEMENTS = '/host/openwop-app/billing/entitlements';

describe('the operator has every feature on their own host', () => {
  it('a paid-bundle route refuses an ordinary tenant and serves the operator, on the same narrowed plan', async () => {
    expect(await webinars(customer)).toBe(403);
    expect(await webinars(operator)).toBe(200);
  });

  it('the entitlement read the SPA locks from agrees with the gate, and reports the plan truthfully', async () => {
    const op = await (await get(operator, ENTITLEMENTS)).json() as { plan: string; allowedFeatures: unknown };
    expect(op.allowedFeatures).toBe('*');
    expect(op.plan).toBe('free'); // unrestricted, not "upgraded"
    const cu = await (await get(customer, ENTITLEMENTS)).json() as { allowedFeatures: unknown };
    expect(Array.isArray(cu.allowedFeatures)).toBe(true);
    expect(cu.allowedFeatures).not.toContain('webinars');
  });

  it('a daemon or tier limit resolving by tenant sees the same thing', async () => {
    expect((await resolveEntitlements(OPERATOR, true)).allowedFeatures).toBe('*');
    expect((await resolveEntitlements(CUSTOMER, true)).allowedFeatures).not.toBe('*');
  });
});

describe('only the allowlist grants it', () => {
  it('the dev-open switch does NOT un-paywall an ordinary tenant', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      expect(isListedSuperadminTenant(CUSTOMER)).toBe(false);
      expect(await webinars(customer)).toBe(403);
      expect((await resolveEntitlements(CUSTOMER, true)).allowedFeatures).not.toBe('*');
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });

  it('an empty or absent allowlist names nobody', () => {
    const prior = process.env.OPENWOP_SUPERADMIN_TENANTS;
    try {
      process.env.OPENWOP_SUPERADMIN_TENANTS = '';
      expect(isListedSuperadminTenant(OPERATOR)).toBe(false);
      expect(isListedSuperadminTenant(undefined)).toBe(false);
      expect(isListedSuperadminTenant('')).toBe(false);
    } finally {
      process.env.OPENWOP_SUPERADMIN_TENANTS = prior;
    }
  });
});
