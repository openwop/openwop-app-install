/**
 * Sales Territory Management — A5 governed surface WRITES (ADR 0272).
 * The ctx.features.territories write methods (activateModel/setQuota) must enforce
 * the RUN OWNER's scope: host:territories:manage for activation, workspace:write
 * for a quota; a system run (no actingUserId) is denied fail-closed.
 * Every denial asserts its MESSAGE: a system run with the `!viewer` guard gone
 * would still be refused `forbidden_scope` (no subject, no scopes), so the code
 * alone cannot say which refusal fired. Every success is read back from the
 * store, not trusted from the surface's own `success: true`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildTerritorySurface } from '../src/features/territories/surface.js';
import { getActiveModelId } from '../src/features/territories/entities/territories.js';
import type { Territory } from '../src/features/territories/entities/territories.js';
import { listQuotas } from '../src/features/territories/entities/quota.js';

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

interface Res<T> { status: number; body: T }
interface LoginBody { user: { userId: string } }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    // The one JSON boundary: each call site names the body's type (product types or a local interface).
    return { status: res.status, body: out as T };
  };
  return { post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;

describe('territories A5 — governed surface writes enforce the run owner scope', () => {
  it('activateModel requires host:territories:manage; setQuota requires workspace:write; system run denied', async () => {
    const tenantId = `org:terrsw-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const editor = client();
    const editorId = (await editor.post<LoginBody>('/host/openwop-app/test/login', { email: `e-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const viewer = client();
    const viewerId = (await viewer.post<LoginBody>('/host/openwop-app/test/login', { email: `v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;

    const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const om = (p: string) => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}${p}`;
    await owner.post(om('/members'), { displayName: 'E', subject: editorId, roles: ['editor'] });
    await owner.post(om('/members'), { displayName: 'V', subject: viewerId, roles: ['viewer'] });

    const t = (p: string) => `/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}${p}`;
    const modelId = (await owner.post<{ modelId: string }>(t('/models'), { name: 'M' })).body.modelId;
    const terr = (await owner.post<Territory>(t(`/models/${modelId}/territories`), { name: 'West' })).body;

    const surfaceFor = (actingUserId?: string) => buildTerritorySurface({ tenantId, ...(actingUserId ? { actingUserId } : {}), runId: `run-${n++}` });

    // activateModel — editor (workspace:write but NOT manage) is DENIED
    await expect(surfaceFor(editorId).activateModel!({ orgId, modelId })).rejects.toMatchObject({ code: 'forbidden_scope', message: 'Missing required scope: host:territories:manage' });
    // ...a system run (no acting user) is DENIED fail-closed, by the acting-user guard
    await expect(surfaceFor(undefined).activateModel!({ orgId, modelId })).rejects.toMatchObject({ code: 'forbidden_scope', message: 'A territory write requires an acting user (system runs are denied).' });
    expect(await getActiveModelId(tenantId, orgId)).toBeNull(); // neither denial activated anything
    // ...the owner (has manage) SUCCEEDS, and the model really is the active one
    expect(await surfaceFor(ownerId).activateModel!({ orgId, modelId })).toMatchObject({ success: true });
    expect(await getActiveModelId(tenantId, orgId)).toBe(modelId);

    // setQuota — the viewer (no workspace:write) is DENIED, and nothing is written
    await expect(surfaceFor(viewerId).setQuota!({ orgId, modelId, territoryId: terr.territoryId, period: '2026-Q1', amount: 5, currency: 'USD' })).rejects.toMatchObject({ code: 'forbidden_scope', message: 'Missing required scope: workspace:write' });
    expect(await listQuotas(tenantId, orgId, modelId)).toEqual([]);
    // ...a system run is DENIED by the same acting-user guard
    await expect(surfaceFor(undefined).setQuota!({ orgId, modelId, territoryId: terr.territoryId, period: '2026-Q1', amount: 5, currency: 'USD' })).rejects.toMatchObject({ code: 'forbidden_scope', message: 'A territory write requires an acting user (system runs are denied).' });
    // ...the editor (has workspace:write) SUCCEEDS, read back from the store
    expect(await surfaceFor(editorId).setQuota!({ orgId, modelId, territoryId: terr.territoryId, period: '2026-Q1', amount: 1000, currency: 'USD' })).toMatchObject({ success: true });
    expect((await listQuotas(tenantId, orgId, modelId)).map((q) => ({ territoryId: q.territoryId, period: q.period, amount: q.amount, currency: q.currency }))).toEqual([
      { territoryId: terr.territoryId, period: '2026-Q1', amount: 1000, currency: 'USD' },
    ]);
  });
});
