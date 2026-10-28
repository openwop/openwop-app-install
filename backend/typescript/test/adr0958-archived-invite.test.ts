/**
 * ADR 0958 D7 — an archived client takes no new collaborator. Through
 * `createApp`, real sessions and the real routes.
 *
 * Before this, accept checked the toggles and the invite but not the client:
 * invite, archive the client, accept, and the collaborator bound as `active`
 * with the grant made before the archive. Un-archiving then brought that grant
 * back with no member decision, the class of the D2 MEDIUM that archive
 * suspension closed for collaborators who had already accepted.
 *
 * Sabotage note (2026-10-27): drop the client-status check in the accept route
 * → the accept during the archive binds (red).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { checkGrantUse, getCollaborator, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_UPLOAD_SCAN_OPTIONAL = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'campaign-brief', 'campaign-orchestration', 'creative-briefs', 'campaign-ops', 'campaign-ops.external-collab']) await setToggle(id, true);
}, 120_000);
afterAll(async () => { delete process.env.OPENWOP_UPLOAD_SCAN_OPTIONAL; await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string; headers: Headers }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw, headers: res.headers };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b), patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b), del: <T>(p: string) => call<T>('DELETE', p) };
}



let n = 0;
async function setup() {
  const tenantId = `ws:t-arch-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-ar-${n}@agency.test`, tenantId });
  expect(login.status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Northwind Coffee' });
  expect((await admin.post('/host/openwop-app/campaign-ops/clients', { name: 'Northwind Coffee', orgId: org.body.orgId })).status).toBe(201);
  const orgId = org.body.orgId;
  const cBrief = await createCampaignBrief(tenantId, orgId, 'seed', { name: 'Spring roast launch', objective: 'Sell 500 bags' });
  const campaign = await finalizeFromBrief(tenantId, cBrief, 'seed');
  const C = `/host/openwop-app/campaign-ops/clients/${orgId}/collaborators`;
  const A = `/host/openwop-app/campaign-ops/clients/${orgId}/intakes`;
  const invite = (email: string) => admin.post<{ collaborator: ExternalCollaborator; invite: { token: string } }>(C, { kind: 'vendor', email, displayName: 'Dana Studio' });
  const grantFor = async (collaboratorId: string): Promise<CollaboratorGrant> => {
    const r = await admin.post<{ grant: CollaboratorGrant }>(`${C}/${collaboratorId}/grants`, { resource: { kind: 'campaign', id: campaign.id }, actions: ['view', 'upload'] });
    expect(r.status, r.raw).toBe(201);
    return r.body.grant;
  };
  return { tenantId, orgId, admin, C, A, invite, grantFor };
}


describe('ADR 0958 D7 — accept while the client is archived', () => {
  it('is refused with the uniform 404 and binds nothing; after un-archive the same invite works', async () => {
    const s = await setup();
    const vendor = client();
    const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `invitee-ar-${n}@studio.test` });
    const email = (await getUser(v.body.user.userId))?.email ?? '';
    const inv = await s.invite(email);
    expect(inv.status, inv.raw).toBe(201);
    const cid = inv.body.collaborator.collaboratorId;
    const g = await s.grantFor(cid);
    const P = `/host/openwop-app/campaign-ops/clients/${s.orgId}`;
    expect((await s.admin.patch(P, { status: 'archived' })).status).toBe(200);

    const refused = await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token });
    expect(refused.status).toBe(404);
    const row = await getCollaborator(s.tenantId, s.orgId, cid);
    expect(row?.status).toBe('invited');
    expect(row?.boundUserId).toBeUndefined();

    expect((await s.admin.patch(P, { status: 'active' })).status).toBe(200);
    expect((await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
    await expect(checkGrantUse({ grantId: g.grantId, via: { userId: v.body.user.userId }, action: 'view' })).resolves.toBeTruthy();
  });
});
