/**
 * ADR 0306 (ADR 0305 Phase G) — GitHub publish. ROUTE-level: the publish route
 * is gated by the `code-publish` toggle + workspace:write; validation 400s;
 * no-GitHub-connection → 424 with an actionable message. Plus the
 * un-bypassability pin: the `github` manifest is adapterOnly with ZERO consumer
 * nodes, so the generic http node can never carry it — distinct from the broad `github` example MCP pack (the microsoft365/microsoft-graph coexistence).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'app-builder']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function orgOwner(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:test-ab-pub-${Date.now()}-${n++}`;
  const c = client();
  expect((await c.post('/host/openwop-app/test/login', { email: `abp-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

const STATE = { name: 'Pub', screens: [{ id: 'home', name: 'Home', components: [{ type: 'text', props: { text: 'x' } }] }] };
const AB = (orgId: string) => `/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}`;
const setPublishToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('code-publish');
  if (d) await saveConfig({ ...d, status }, 'test');
};

describe('github provider un-bypassability (the ADR 0292 posture, pinned)', () => {
  it('is adapterOnly with zero consumer nodes — never injectable for the generic http node', () => {
    const m = getProvider('github-publish');
    expect(m?.adapterOnly).toBe(true);
    expect(m?.consumerNodes).toEqual([]);
    expect(m?.apiHosts).toEqual(['api.github.com']);
    // The generic-injection skip for adapterOnly manifests is pinned behaviorally
    // in connection-injection.test.ts ("does NOT inject for an adapterOnly
    // provider"); these manifest flags are what put `github` under that pin.
  });
});

describe('publish route (ADR 0306)', () => {
  it('is OFF until the code-publish toggle is enabled', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'P', initialState: STATE });
    await setPublishToggle('off');
    const off = await c.post(`${AB(orgId)}/canvases/${canvas.canvasId}/publish`, { target: 'html-css', repo: 'my-app' });
    // A toggle-off route does not exist for the tenant: exactly 404 not_found
    // (a 403 here would be a different gate answering).
    expect(off.status, JSON.stringify(off.body)).toBe(404);
    expect(off.body.error).toBe('not_found');
  });

  // The header's workspace:write gate, witnessed by a SAME-tenant caller with no
  // membership (a second login into the tenant ⇒ zero scopes). A cross-tenant
  // stranger would be refused by the org lookup before the scope check runs.
  it('a same-tenant non-member AND a viewer are refused 403 forbidden_scope before any GitHub call', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'P', initialState: STATE });
    const stranger = client();
    expect((await stranger.post('/host/openwop-app/test/login', { email: `abp-x-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
    // A viewer holds workspace:read — enough to see the app, not to publish it.
    const viewer = client();
    const viewerUser = (await viewer.post('/host/openwop-app/test/login', { email: `abp-v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user as { userId: string };
    const add = await c.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Vi', subject: viewerUser.userId, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    await setPublishToggle('on');
    try {
      for (const who of [stranger, viewer]) {
        const r = await who.post(`${AB(orgId)}/canvases/${canvas.canvasId}/publish`, { target: 'html-css', repo: 'my-app' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body.error).toBe('forbidden_scope');
      }
    } finally {
      await setPublishToggle('off');
    }
  });

  it('validates target + repo name, then 424s without a GitHub connection', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'P', initialState: STATE });
    await setPublishToggle('on');
    try {
      const badTarget = await c.post(`${AB(orgId)}/canvases/${canvas.canvasId}/publish`, { target: 'cobol', repo: 'my-app' });
      expect(badTarget.status).toBe(400);
      const badRepo = await c.post(`${AB(orgId)}/canvases/${canvas.canvasId}/publish`, { target: 'html-css', repo: 'bad repo name!' });
      expect(badRepo.status).toBe(400);
      // No github connection exists in this tenant → actionable 424, never a 500.
      const noConn = await c.post(`${AB(orgId)}/canvases/${canvas.canvasId}/publish`, { target: 'html-css', repo: 'my-app' });
      expect(noConn.status, JSON.stringify(noConn.body)).toBe(424);
      expect(String(noConn.body.message)).toContain('GitHub');
    } finally {
      await setPublishToggle('off');
    }
  });
});
