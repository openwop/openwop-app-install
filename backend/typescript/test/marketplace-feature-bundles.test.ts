/**
 * ADR 0366 P3 — the marketplace feature-bundles projection, pinned:
 *  - serves the repo's distributions/bundles.json enriched with compiled
 *    toggle labels + a `registered` flag (honest gap for excluded features);
 *  - read-only: there is NO write twin on the surface (a distribution
 *    manifest becomes real only via a repo PR + the gated build);
 *  - same gate posture as /listings (toggle + authenticated caller).
 * Auth bootstrap mirrors test/marketplace-route.test.ts (the sibling pattern).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let cookie = '';
const PATH = '/v1/host/openwop-app/marketplace/feature-bundles';

const get = (path: string, withAuth = true) =>
  fetch(`${BASE}${path}`, { headers: withAuth && cookie ? { cookie } : {} });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'marketplace']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bundles@acme.test', tenantId: 't-bundles' }),
  });
  expect(login.status).toBe(201);
  const h = login.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) cookie = m[1];
  }
  expect(cookie).not.toBe('');
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0366 P3 — marketplace feature-bundles', () => {
  type Feat = { id: string; label?: string; category?: string; dependsOn: string[]; registered: boolean };
  type Body = {
    available: boolean;
    bundles: { id: string; label: string; features: Feat[] }[];
    standalone: Feat[];
    core: Feat[];
  };

  it('serves the bundle catalog with registry-enriched features', async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.available).toBe(true);
    const sales = body.bundles.find((b) => b.id === 'sales');
    expect(sales, 'the sales bundle from distributions/bundles.json').toBeTruthy();
    const territories = sales?.features.find((f) => f.id === 'territories');
    expect(territories?.registered).toBe(true);
    expect(typeof territories?.label).toBe('string'); // compiled toggle label, not the raw id
    // territories hard-depends on crm — the shop closes this over the selection.
    expect(territories?.dependsOn).toContain('crm');
  });

  it('projects the P4 three tiers — bundles + standalone + read-only core', async () => {
    const res = await get(PATH);
    const body = await res.json() as Body;
    // a sellable category is a bundle…
    expect(body.bundles.map((b) => b.id)).toContain('crm');
    // …a non-core, non-bundled feature is individually selectable (standalone)…
    expect(body.standalone.map((f) => f.id)).toContain('voice');
    // …and the substrate is core, read-only (kb + orgs graduated to always-on).
    expect(body.core.map((f) => f.id)).toContain('orgs');
    expect(body.core.map((f) => f.id)).toContain('kb');
    // the three tiers are disjoint (a feature belongs to exactly one place).
    const bundled = new Set(body.bundles.flatMap((b) => b.features.map((f) => f.id)));
    const standalone = new Set(body.standalone.map((f) => f.id));
    const core = new Set(body.core.map((f) => f.id));
    for (const id of standalone) { expect(bundled.has(id)).toBe(false); expect(core.has(id)).toBe(false); }
    for (const id of core) expect(bundled.has(id)).toBe(false);
  });

  it('requires an authenticated caller (the /listings posture)', async () => {
    const res = await get(PATH, false);
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  it('exposes no write twin — POST/PUT/DELETE are not routed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${BASE}${PATH}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, `${method} must not exist`).toBeGreaterThanOrEqual(404);
    }
  });
});
