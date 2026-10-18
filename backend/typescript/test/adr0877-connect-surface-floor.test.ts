/**
 * ADR 0877 D5 (grade-code CC2CD-8) — `ctx.features['commerce-connect'].createCheckout`
 * asks what its HTTP door asks (`workspace:write`). Before: a run acting for a
 * VIEWER started a purchase the viewer's own `POST …/purchase/checkout` is refused.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce-connect']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { post };
}

let n = 0;
async function team(): Promise<{ tenantId: string; editorId: string; viewerId: string }> {
  const tenantId = `org:a0877s-${Date.now()}-${n++}`;
  const ids: string[] = [];
  const owner = client();
  for (const c of [owner, client(), client()]) {
    const r = await c.post('/host/openwop-app/test/login', { email: `a0877s-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push((r.body as { user: { userId: string } }).user.userId);
  }
  const [, editorId, viewerId] = ids as [string, string, string];
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = (org.body as { orgId: string }).orgId;
  for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { tenantId, editorId, viewerId };
}

describe('ADR 0877 D5 — a viewer\'s run cannot open a Commerce Connect checkout', () => {
  it('createCheckout needs workspace:write; reads stay at the read tier', async () => {
    const t = await team();
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v', actingUserId: t.viewerId })['commerce-connect']!;
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e', actingUserId: t.editorId })['commerce-connect']!;
    await expect(asViewer.createCheckout!({ packName: 'feature.crm.nodes' })).rejects.toMatchObject({ code: 'forbidden_scope' }); // RED on origin/main: reached the service
    // The editor passes the floor and reaches the service, which refuses an unlisted pack.
    await expect(asEditor.createCheckout!({ packName: 'feature.crm.nodes' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await asViewer.listPaidListings!({})).toMatchObject({ listings: expect.any(Array) });
  });
});
