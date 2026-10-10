/**
 * ADR 0837 D2 — `ctx.features.crm` asks what the HTTP doors ask (`CRM2WF-2`).
 *
 * Before: `crm` registered its surface with no `orgPolicy`, so the ADR 0832 floor
 * asked `workspace:read` of every method — the org writers included — and the
 * contact writers, which name no `orgId`, met no floor at all. A run acting for a
 * VIEWER created companies and contacts the viewer's own HTTP calls are refused.
 *
 * The partition test is the ratchet: every method the surface returns must be
 * classified, so a new writer cannot ship at the read-tier default.
 *
 * Sabotage-witnessed (w4 grade-tests): dropping a writer from its partition set
 * reds the partition AND the viewer case; emptying `methodScopes` /
 * `tenantMethodScopes` in `CRM_SURFACE_POLICY` reds the matching viewer case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  buildCrmSurface, CRM_SURFACE_LANE_INTERNAL, CRM_SURFACE_ORG_WRITERS, CRM_SURFACE_READS, CRM_SURFACE_TENANT_WRITERS,
} from '../src/features/crm/surface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE; // the de-facto-owner bypass would admit every refusal below
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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
async function team(): Promise<{ tenantId: string; orgId: string; ownerId: string; editorId: string; viewerId: string }> {
  const tenantId = `org:a0837f-${Date.now()}-${n++}`;
  const ids: string[] = [];
  const owner = client();
  for (const c of [owner, client(), client()]) {
    const r = await c.post('/host/openwop-app/test/login', { email: `a0837f-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push((r.body as { user: { userId: string } }).user.userId);
  }
  const [ownerId, editorId, viewerId] = ids as [string, string, string];
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = (org.body as { orgId: string }).orgId;
  for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { tenantId, orgId, ownerId, editorId, viewerId };
}

describe('ADR 0837 D2 — the CRM surface method partition is closed-world', () => {
  it('every method is classified exactly once', () => {
    const methods = Object.keys(buildCrmSurface({ tenantId: 't-partition' })).sort();
    const sets = [CRM_SURFACE_READS, CRM_SURFACE_ORG_WRITERS, CRM_SURFACE_TENANT_WRITERS, CRM_SURFACE_LANE_INTERNAL].map((s) => [...s] as string[]);
    const classified = sets.flat();
    expect(new Set(classified).size, 'a method is in two sets').toBe(classified.length);
    expect(classified.sort()).toEqual(methods);
  });
});

describe('ADR 0837 D2 — a viewer\'s run cannot write through ctx.features.crm', () => {
  it('org writers need workspace:write in the named org', async () => {
    const t = await team();
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v', actingUserId: t.viewerId }).crm!;
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e', actingUserId: t.editorId }).crm!;
    await expect(asViewer.createCompany!({ orgId: t.orgId, name: 'Planted Co' })).rejects.toMatchObject({ code: 'forbidden_scope' }); // RED on origin/main: created
    await expect(asViewer.createTask!({ orgId: t.orgId, title: 'planted' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await asViewer.listCompanies!({ orgId: t.orgId })).toMatchObject({ companies: [] }); // reads stay at the read tier
    expect(await asEditor.createCompany!({ orgId: t.orgId, name: 'Real Co' })).toMatchObject({ success: true });
  });

  it('tenant writers (no orgId) need workspace:write in the tenant', async () => {
    const t = await team();
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v2', actingUserId: t.viewerId }).crm!;
    const asOwner = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-o2', actingUserId: t.ownerId }).crm!;
    await expect(asViewer.createContact!({ name: 'Planted', email: `planted-${n++}@x.test` })).rejects.toMatchObject({ code: 'forbidden_scope' }); // RED on origin/main: created
    expect(await asOwner.createContact!({ name: 'Real', email: `real-${n++}@x.test` })).toMatchObject({ success: true });
    // A run with no person behind it stays tenant-trusted (the floor's existing rule).
    const system = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-sys' }).crm!;
    expect(await system.createContact!({ name: 'System', email: `sys-${n++}@x.test` })).toMatchObject({ success: true });
  });
});
