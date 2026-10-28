/**
 * ADR 0958 matrix row 10 — `GET …/collaborators/grantable`, the picker behind
 * the agency's Collaborators panel. Through `createApp` and real sessions.
 *
 *   - It offers the client's live campaigns and APPROVED briefs (a draft brief
 *     could not be shown to a collaborator, so it is not offered), each kind
 *     with the actions it supports. The portal's change-set kind, which only
 *     the feature may mint, is never offered.
 *   - Another client's campaign and brief are not offered.
 *   - It adds no authority: a client viewer (who can read the client) is
 *     refused, as on every collaborator route; dark with the toggle off.
 *   - What it offers can be granted, and another client's brief is refused by
 *     the grant route anyway (404): the picker is a convenience, never the
 *     check. (A draft brief of THIS client can still be granted by id through
 *     the route; it reads dark to the collaborator until approved, P2.)
 *
 * Sabotage notes (2026-10-28), each red when applied alone:
 *   - drop the approved filter on the brief list → the draft is offered (red);
 *   - drop the `systemMintOnly` skip → the change-set kind appears (red);
 *   - list campaigns without the org → the other client's campaign appears (red).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { registerGrantResourceKind, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';
import { createBrief, transitionBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { createMember } from '../src/host/accessControlService.js';

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
  const tenantId = `ws:t-grantable-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-gr-${n}@agency.test`, tenantId });
  expect(login.status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Northwind Coffee' });
  expect((await admin.post('/host/openwop-app/campaign-ops/clients', { name: 'Northwind Coffee', orgId: org.body.orgId })).status).toBe(201);
  const orgId = org.body.orgId;
  const org2 = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Other Client' });
  expect((await admin.post('/host/openwop-app/campaign-ops/clients', { name: 'Other Client', orgId: org2.body.orgId })).status).toBe(201);
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
  return { tenantId, orgId, otherOrgId: org2.body.orgId, campaign, admin, C, A, invite, grantFor };
}


type Kind = { kind: string; actions: string[]; items: Array<{ id: string; title: string }> };

describe('ADR 0958 matrix row 10 — what the Collaborators panel may offer', () => {
  it('offers live campaigns and approved briefs of this client only, never a system-only kind', async () => {
    const s = await setup();
    const approved = await createBrief(s.tenantId, s.orgId, 'seed', { title: 'Hero bottle shot', sceneDescription: 'A bottle', directions: [{ name: 'Morning', description: 'Warm light' }] });
    await transitionBrief(s.tenantId, s.orgId, approved.briefId, 'seed', 'review');
    await transitionBrief(s.tenantId, s.orgId, approved.briefId, 'seed', 'approved');
    const draft = await createBrief(s.tenantId, s.orgId, 'seed', { title: 'Draft only', sceneDescription: 'Not yet', directions: [{ name: 'A', description: 'B' }] });
    const elsewhere = await createBrief(s.tenantId, s.otherOrgId, 'seed', { title: 'Other client brief', sceneDescription: 'x', directions: [{ name: 'A', description: 'B' }] });
    await transitionBrief(s.tenantId, s.otherOrgId, elsewhere.briefId, 'seed', 'review');
    await transitionBrief(s.tenantId, s.otherOrgId, elsewhere.briefId, 'seed', 'approved');
    const otherCampaign = await finalizeFromBrief(s.tenantId, await createCampaignBrief(s.tenantId, s.otherOrgId, 'seed', { name: 'Other launch', objective: 'x' }), 'seed');

    const r = await s.admin.get<{ kinds: Kind[] }>(`${s.C}/grantable`);
    expect(r.status, r.raw).toBe(200);
    const byKind = new Map(r.body.kinds.map((k) => [k.kind, k]));
    expect([...byKind.keys()].sort()).toEqual(['campaign', 'creative-brief']);
    expect(byKind.get('campaign')).toEqual({ kind: 'campaign', actions: ['view', 'upload'], items: [{ id: s.campaign.id, title: 'Spring roast launch' }] });
    expect(byKind.get('creative-brief')).toEqual({ kind: 'creative-brief', actions: ['view'], items: [{ id: approved.briefId, title: 'Hero bottle shot' }] });
    expect(r.raw).not.toContain(draft.briefId);
    expect(r.raw).not.toContain(elsewhere.briefId);
    expect(r.raw).not.toContain(otherCampaign.id);

    // The picker is not the check: an offered item grants, an unoffered one is refused.
    const inv = await s.invite(`picker-${n}@studio.test`);
    const cid = inv.body.collaborator.collaboratorId;
    expect((await s.admin.post(`${s.C}/${cid}/grants`, { resource: { kind: 'creative-brief', id: approved.briefId }, actions: ['view'] })).status).toBe(201);
    expect((await s.admin.post(`${s.C}/${cid}/grants`, { resource: { kind: 'creative-brief', id: elsewhere.briefId }, actions: ['view'] })).status).toBe(404);
  });

  it('never offers a kind only the feature may mint, even one that can list itself', async () => {
    // The portal's change-set kind has no `list`, so it would be left out anyway;
    // this kind lists, so only the systemMintOnly skip keeps it out.
    registerGrantResourceKind('test-system-only', {
      featureId: null, actions: ['view'], systemMintOnly: true,
      async exists() { return true; }, async project() { return null; },
      async list() { return [{ id: 'sys-1', title: 'System only' }]; },
    });
    const s = await setup();
    const r = await s.admin.get<{ kinds: Kind[] }>(`${s.C}/grantable`);
    expect(r.status).toBe(200);
    expect(r.body.kinds.map((k) => k.kind)).not.toContain('test-system-only');
  });

  it('adds no authority: a client viewer is refused; dark with the toggle off', async () => {
    const s = await setup();
    const viewer = client();
    const vl = await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `viewer-gr-${n}@agency.test` });
    await createMember({ orgId: s.tenantId, tenantId: s.tenantId, displayName: 'Viewer', subject: vl.body.user.userId, roles: ['viewer'] });
    await createMember({ orgId: s.orgId, tenantId: s.tenantId, displayName: 'Viewer', subject: vl.body.user.userId, roles: ['viewer'] });
    expect((await viewer.post(`/host/openwop-app/workspaces/${encodeURIComponent(s.tenantId)}/switch`)).status).toBe(200);
    expect((await viewer.get(s.A)).status).toBe(200); // control: the viewer can read the client
    expect((await viewer.get(`${s.C}/grantable`)).status).toBe(403);
    await setToggle('campaign-ops.external-collab', false);
    try {
      expect((await s.admin.get(`${s.C}/grantable`)).status).toBe(404);
    } finally { await setToggle('campaign-ops.external-collab', true); }
  });
});
