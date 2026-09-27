/**
 * Per-tenant pack enablement (ADR 0194 Phase 3 / ADR 0022 alt. 4) — route harness.
 *
 * Boots the real app and drives: the enablement CRUD (toggle-gated, workspace
 * self-service), the node-catalog authoring filter (tenant-scoped; a second
 * tenant is untouched — isolation), the registration choke point (403 forbidden
 * + details.disabledPacks on POST /workflows), unknown-typeId behavior UNCHANGED
 * (registration has never done a closed-world check), and re-enable restoring
 * the default. Enforcement is observable only at the HTTP boundary.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __clearPackEnablement } from '../src/features/marketplace/packEnablementService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'marketplace']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await __clearPackEnablement();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
  };
}

let n = 0;
async function tenantUser(): Promise<ReturnType<typeof client>> {
  const c = client();
  n += 1;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `pe-${n}@acme.test`, tenantId: `t-pe-${n}` });
  expect(r.status).toBe(201);
  return c;
}

interface CatalogNode { typeId: string; packName?: string; source: string }

/** A pack that declares nodes in the live catalog — the enforcement target. */
async function packWithNodes(c: ReturnType<typeof client>): Promise<{ packName: string; typeId: string }> {
  const cat = await c.get('/v1/host/openwop-app/node-catalog');
  expect(cat.status).toBe(200);
  const node = (cat.body.nodes as CatalogNode[]).find((x) => x.source === 'pack' && x.packName);
  expect(node, 'test env needs at least one pack-declared node in the catalog').toBeTruthy();
  return { packName: node!.packName!, typeId: node!.typeId };
}

describe('pack enablement (ADR 0194 P3)', () => {
  it('disable → palette filter (tenant-scoped) → registration 403 → re-enable restores', async () => {
    const a = await tenantUser();
    const b = await tenantUser();
    const { packName, typeId } = await packWithNodes(a);

    // Baseline: empty deny list.
    const before = await a.get('/v1/host/openwop-app/marketplace/pack-enablement');
    expect(before.status).toBe(200);
    expect(before.body.disabled).toEqual([]);

    // Disable for tenant A.
    const put = await a.put(`/v1/host/openwop-app/marketplace/pack-enablement/${encodeURIComponent(packName)}`, { enabled: false });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await a.get('/v1/host/openwop-app/marketplace/pack-enablement')).body.disabled).toEqual([packName]);

    // Palette: A no longer sees the pack's nodes; B (another tenant) still does.
    const catA = await a.get('/v1/host/openwop-app/node-catalog');
    expect((catA.body.nodes as CatalogNode[]).some((x) => x.packName === packName)).toBe(false);
    const catB = await b.get('/v1/host/openwop-app/node-catalog');
    expect((catB.body.nodes as CatalogNode[]).some((x) => x.packName === packName)).toBe(true);

    // Registration choke point: A is refused with the curated-dimension error…
    const defBody = { workflowId: `pe.block.${n}`, nodes: [{ nodeId: 'n1', typeId }], edges: [] };
    const regA = await a.post('/v1/host/openwop-app/workflows', defBody);
    expect(regA.status).toBe(403);
    expect(regA.body.error).toBe('forbidden');
    expect(regA.body.details?.disabledPacks).toContain(packName);
    // …while B registers the same shape fine (isolation).
    const regB = await b.post('/v1/host/openwop-app/workflows', { ...defBody, workflowId: `pe.ok.${n}` });
    expect([200, 201]).toContain(regB.status);

    // Unknown typeIds keep today's behavior — no closed-world gate smuggled in.
    const regUnknown = await a.post('/v1/host/openwop-app/workflows', {
      workflowId: `pe.unknown.${n}`,
      nodes: [{ nodeId: 'n1', typeId: 'totally.unknown.type' }],
      edges: [],
    });
    expect([200, 201]).toContain(regUnknown.status);

    // Re-enable restores the default.
    expect((await a.put(`/v1/host/openwop-app/marketplace/pack-enablement/${encodeURIComponent(packName)}`, { enabled: true })).status).toBe(200);
    const catA2 = await a.get('/v1/host/openwop-app/node-catalog');
    expect((catA2.body.nodes as CatalogNode[]).some((x) => x.packName === packName)).toBe(true);
    const regA2 = await a.post('/v1/host/openwop-app/workflows', { ...defBody, workflowId: `pe.after.${n}` });
    expect([200, 201]).toContain(regA2.status);
  });

  it('validates input and 404s an unknown pack', async () => {
    const a = await tenantUser();
    expect((await a.put('/v1/host/openwop-app/marketplace/pack-enablement/no.such.pack', { enabled: false })).status).toBe(404);
    const { packName } = await packWithNodes(a);
    expect((await a.put(`/v1/host/openwop-app/marketplace/pack-enablement/${encodeURIComponent(packName)}`, { enabled: 'nope' })).status).toBe(400);
  });

  it('toggle OFF ⇒ the curation routes 404 (backend authority)', async () => {
    const a = await tenantUser();
    const d = getToggleDefault('marketplace');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect((await a.get('/v1/host/openwop-app/marketplace/pack-enablement')).status).toBe(404);
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});
