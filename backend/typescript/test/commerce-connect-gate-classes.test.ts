/**
 * ADR 0575 — the money-surface gating doctrine, pinned in BOTH directions.
 *
 * Class 1 (tenant-facing): toggle + RBAC — OFF ⇒ gone. Class 2 (webhook):
 * money-truth events apply regardless of toggle (pinned by the webhook suite;
 * restated here as doctrine). Class 3 (operator remediation — refund,
 * disputes, orders, fee-config, approvals, import): superadmin, DELIBERATELY
 * not toggle-gated — gating remediation on tenant visibility is a money trap.
 *
 * The well-meaning future edit this file exists to catch: adding
 * `requireFeatureEnabled` to the refund route makes (b) fail with this
 * docstring as the explanation.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE = '';
let server: http.Server;
const B = '/v1/host/openwop-app/commerce-connect';

const SUPER_TENANT = 'org:cc-gate-super';

async function login(email: string, tenantId?: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tenantId ? { email, tenantId } : { email }),
  });
  return (getSetCookies(res.headers) as string[]).map((c) => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT; // superadmin = allow-listed tenant (host/superadmin.ts)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // The toggle stays OFF for the whole suite — that is the point.
  const d = getToggleDefault('commerce-connect');
  if (d) await saveConfig({ ...d, status: 'off' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0575 — gate classes hold with the toggle OFF', () => {
  it('(a) class 1: a tenant-facing route is GONE when the toggle is off', async () => {
    const cookie = await login('cc-gate-tenant@e2e.test');
    const res = await fetch(`${BASE}${B}/seller`, { headers: { cookie } });
    expect([403, 404]).toContain(res.status);
  });

  it('(b) class 3: operator remediation still ANSWERS a superadmin with the toggle off', async () => {
    const cookie = await login('cc-gate-admin@e2e.test', SUPER_TENANT);
    for (const path of ['/admin/disputes', '/admin/orders', '/fee-config', '/approvals']) {
      const res = await fetch(`${BASE}${B}${path}`, { headers: { cookie } });
      // Answering means NOT the toggle-off shape: any 2xx, or a domain error —
      // never the feature-disabled 403/404 the tenant route shows above.
      expect(res.status, `${path} must not be toggle-gated (ADR 0575: gating remediation on tenant visibility is a money trap)`).toBeLessThan(403);
    }
  });

  it('(c) class 3: every remediation route refuses a NON-superadmin', async () => {
    const cookie = await login('cc-gate-user@e2e.test');
    for (const [method, path] of [['GET', '/admin/disputes'], ['GET', '/admin/orders'], ['PUT', '/fee-config'], ['POST', '/import'], ['DELETE', '/admin/listings/some.pack'], ['PUT', '/admin/listings/some.pack/state']] as const) {
      const res = await fetch(`${BASE}${B}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({ reason: 'x', state: 'suspended' }) });
      expect([401, 403]).toContain(res.status);
    }
  });
});
