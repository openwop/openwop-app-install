/**
 * ADR 0366 P3 — the marketplace feature-bundles projection, pinned:
 *  - serves the repo's distributions/bundles.json enriched with compiled
 *    toggle labels + a `registered` flag (honest gap for excluded features);
 *  - read-only: there is NO write twin on the surface (a distribution
 *    manifest becomes real only via a repo PR + the gated build);
 *  - same gate posture as /listings (toggle + authenticated caller).
 * Auth bootstrap mirrors test/marketplace-route.test.ts (the sibling pattern).
 *
 * Sabotage witnesses (wave 10): dropping the compiled label / dependsOn /
 * registered flag, un-bundling standalone, reordering or dropping groups, removing
 * `resolveCallerUser`, or routing the path for every method — each turns its case red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let cookie = '';
const PATH = '/host/openwop-app/marketplace/feature-bundles';

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
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
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
    groups: string[];
    bundles: { id: string; label: string; group?: string; features: Feat[] }[];
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

  it('ADR 0820 §7 UI — projects the store goal-groups from bundles.json as DATA', async () => {
    const body = await (await get(PATH)).json() as Body;
    const file = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'distributions', 'bundles.json'), 'utf8')) as {
      groups: string[]; bundles: Record<string, { group?: string }>;
    };
    // The order and the membership are the file's, verbatim — no UI-side map.
    expect(body.groups).toEqual(file.groups);
    expect(body.groups.length).toBeGreaterThan(0);
    for (const b of body.bundles) expect(b.group).toBe(file.bundles[b.id]?.group);
    expect(body.bundles.find((b) => b.id === 'crm')?.group).toBe('sell-grow');
    expect(body.bundles.find((b) => b.id === 'job-search')?.group).toBe('standalone');
  });

  it('requires an authenticated caller (the /listings posture)', async () => {
    const res = await get(PATH, false);
    // Exactly 401 — a range let a 404 (toggle off) or a 500 read as "auth enforced".
    expect(res.status).toBe(401);
  });

  it('exposes no write twin — POST/PUT/DELETE are not routed', async () => {
    // Positive control: the same cookie reads the path, so a 404 below is about the method.
    expect((await get(PATH)).status).toBe(200);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${BASE}${PATH}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      // Exactly 404 (unrouted) — a range let a crashing write twin (500) pass.
      expect(res.status, `${method} must not exist`).toBe(404);
    }
  });
});
