/**
 * ADR 0820 §1 — the Agents bundle now gates the twin. Before the fix,
 * `bundles.json` listed `twin` while the toggle id is `twin-recall`, so
 * `isSellableBundleFeature('twin-recall')` was false and a free-plan tenant was
 * served every twin route. The catalog test (`bundle-ids-are-toggle-ids`) proves
 * membership; this proves ENFORCEMENT through the HTTP boundary, with a positive
 * control (the same tenant is served once it owns the bundle).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isSellableBundleFeature } from '../src/host/featureBundles.js';
import { __resetBilling, processStripeEvent } from '../src/features/billing/billingService.js';

let server: http.Server;
let BASE: string;
let cookie = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_agents: 'agents' });
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'twin-recall']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'twin@acme.test', tenantId: 't-twin' }),
  });
  const h = login.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1];
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); });

const grants = () => fetch(`${BASE}/host/openwop-app/profiles/me/twin-grants`, { headers: { cookie } });

describe('ADR 0820 §1 — twin-recall is sold by the Agents bundle', () => {
  it('twin-recall is a sellable bundle feature (the id fix)', () => {
    expect(isSellableBundleFeature('twin-recall')).toBe(true);
  });

  it('a free-plan tenant is refused with the plan 403, then served once Agents is owned', async () => {
    expect(cookie, 'test login must issue a session').not.toBe('');
    expect((await grants()).status).toBe(403);
    await processStripeEvent('t-twin', {
      id: 'evt_twin_1', type: 'customer.subscription.created',
      data: { object: { id: 'sub_twin', status: 'active', metadata: { tenantId: 't-twin', bundleId: 'agents' }, items: { data: [{ price: { id: 'price_agents' } }] } } },
    });
    const served = await grants();
    expect(served.status).not.toBe(403);
    expect(served.status).toBeLessThan(500);
  });
});
