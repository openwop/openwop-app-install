/**
 * Sales Territory Management — A5 governed surface WRITES (ADR 0272).
 * The ctx.features.territories write methods (activateModel/setQuota) must enforce
 * the RUN OWNER's scope: host:territories:manage for activation, workspace:write
 * for a quota; a system run (no actingUserId) is denied fail-closed.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildTerritorySurface } from '../src/features/territories/surface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'territories']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;

describe('territories A5 — governed surface writes enforce the run owner scope', () => {
  it('activateModel requires host:territories:manage; setQuota requires workspace:write; system run denied', async () => {
    const tenantId = `org:terrsw-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const editor = client();
    const editorId = (await editor.post('/v1/host/openwop-app/test/login', { email: `e-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const viewer = client();
    const viewerId = (await viewer.post('/v1/host/openwop-app/test/login', { email: `v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;

    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const om = (p: string) => `/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}${p}`;
    await owner.post(om('/members'), { displayName: 'E', subject: editorId, roles: ['editor'] });
    await owner.post(om('/members'), { displayName: 'V', subject: viewerId, roles: ['viewer'] });

    const t = (p: string) => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}${p}`;
    const modelId = (await owner.post(t('/models'), { name: 'M' })).body.modelId;
    const terr = (await owner.post(t(`/models/${modelId}/territories`), { name: 'West' })).body;

    const surfaceFor = (actingUserId?: string) => buildTerritorySurface({ tenantId, ...(actingUserId ? { actingUserId } : {}), runId: `run-${n++}` });

    // activateModel — editor (workspace:write but NOT manage) is DENIED
    await expect(surfaceFor(editorId).activateModel!({ orgId, modelId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    // ...a system run (no acting user) is DENIED fail-closed
    await expect(surfaceFor(undefined).activateModel!({ orgId, modelId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    // ...the owner (has manage) SUCCEEDS
    const act = await surfaceFor(ownerId).activateModel!({ orgId, modelId });
    expect((act as { success: boolean }).success).toBe(true);

    // setQuota — editor (has workspace:write) SUCCEEDS
    const q = await surfaceFor(editorId).setQuota!({ orgId, modelId, territoryId: terr.territoryId, period: '2026-Q1', amount: 1000, currency: 'USD' });
    expect((q as { success: boolean }).success).toBe(true);
    // ...the viewer (no workspace:write) is DENIED
    await expect(surfaceFor(viewerId).setQuota!({ orgId, modelId, territoryId: terr.territoryId, period: '2026-Q1', amount: 5, currency: 'USD' })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });
});
