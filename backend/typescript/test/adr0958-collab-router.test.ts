/**
 * ADR 0958 P2 — the collaborator's side: "Shared with me", one granted resource,
 * the `creative-brief` and `campaign` grant kinds, and witness 1.
 *
 *   - "Shared with me" lists every grant the signed-in person can use right now,
 *     across agencies, with the resource's title and the client's name, never an
 *     agency id; a revoked grant drops out at once.
 *   - A granted APPROVED brief is served through its owner's projection; a brief
 *     demoted to draft goes dark (the share-link rule); a campaign shows its
 *     working brief (name, objective, channels, status), never budget or kernel.
 *   - Another signed-in user naming the same grant id gets the uniform 404.
 *   - The owning feature turned off in the agency darkens the grant.
 *   - Witness 1 — a collaborator session reaches nothing of the agency through the
 *     agency's own routes (client, briefs, campaigns, media, comments): each is a
 *     refusal, and none of them returns the granted brief's content.
 *
 * Sabotage notes (2026-10-20): skip the owner's `project` null for a draft brief
 * → red; drop the owning-feature toggle in `checkGrantUse` → red; serve the
 * grant read without `checkGrantUse` → red (another user reads it); list from
 * grants without the per-use check → red (a revoked grant still listed).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { createBrief, transitionBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import type { CollaboratorGrant, ExternalCollaborator } from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms', 'comments', 'projects', 'campaign-brief', 'campaign-orchestration', 'creative-briefs', 'campaign-ops', 'campaign-ops.external-collab']) await setToggle(id, true);
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string; cacheControl?: string | null }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw, cacheControl: res.headers.get('cache-control') };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p) };
}

let n = 0;
const SECRET = 'The bottle must face left; matte label; no competitor in frame';

async function setup() {
  const tenantId = `ws:t-router-${n++}`;
  const admin = client();
  expect((await admin.post('/host/openwop-app/test/login', { email: `agency-r-${n}@agency.test`, tenantId })).status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Northwind Coffee' });
  expect((await admin.post('/host/openwop-app/campaign-ops/clients', { name: 'Northwind Coffee', orgId: org.body.orgId })).status).toBe(201);
  const orgId = org.body.orgId;
  const brief = await createBrief(tenantId, orgId, 'seed', { title: 'Hero bottle shot', sceneDescription: SECRET, directions: [{ name: 'Morning', description: 'Warm light' }] });
  await transitionBrief(tenantId, orgId, brief.briefId, 'seed', 'review');
  await transitionBrief(tenantId, orgId, brief.briefId, 'seed', 'approved');
  const cBrief = await createCampaignBrief(tenantId, orgId, 'seed', { name: 'Spring roast launch', objective: 'Sell 500 bags' });
  const campaign = await finalizeFromBrief(tenantId, cBrief, 'seed');
  const vendor = client();
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `designer-${n}@studio.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const C = `/host/openwop-app/campaign-ops/clients/${orgId}/collaborators`;
  const inv = await admin.post<{ collaborator: ExternalCollaborator; invite: { token: string } }>(C, { kind: 'freelancer', email, displayName: 'Dana Designer' });
  expect((await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const grant = async (kind: string, id: string): Promise<CollaboratorGrant> => {
    const r = await admin.post<{ grant: CollaboratorGrant }>(`${C}/${inv.body.collaborator.collaboratorId}/grants`, { resource: { kind, id }, actions: ['view'] });
    expect(r.status, r.raw).toBe(201);
    return r.body.grant;
  };
  return { tenantId, orgId, admin, vendor, brief, campaign, collaborator: inv.body.collaborator, grant, C };
}

interface Shared { items: Array<{ grantId: string; resourceKind: string; title: string; clientName?: string; expiresAt: string }> }
interface GrantView { title: string; clientName?: string; resource: Record<string, unknown>; grant: { grantId: string } }

describe('ADR 0958 P2 — Shared with me and the granted resource', () => {
  it('lists usable grants with title and client name, and serves the approved brief', async () => {
    const s = await setup();
    const g = await s.grant('creative-brief', s.brief.briefId);
    const shared = await s.vendor.get<Shared>('/host/openwop-app/collab/shared');
    expect(shared.cacheControl, 'ADR 0887 S4: a revocable read is never cached').toBe('no-store');
    expect(shared.status, shared.raw).toBe(200);
    expect(shared.body.items).toEqual([expect.objectContaining({ grantId: g.grantId, resourceKind: 'creative-brief', title: 'Hero bottle shot', clientName: 'Northwind Coffee' })]);
    expect(shared.raw).not.toContain(s.tenantId);
    expect(shared.raw).not.toContain(s.orgId);
    const view = await s.vendor.get<GrantView>(`/host/openwop-app/collab/grants/${g.grantId}`);
    expect(view.cacheControl).toBe('no-store');
    expect(view.status, view.raw).toBe(200);
    expect(String(view.body.resource.markdown)).toContain(SECRET);
  });

  it('a brief demoted to draft goes dark; a campaign shows its working brief only', async () => {
    const s = await setup();
    const gb = await s.grant('creative-brief', s.brief.briefId);
    const gc = await s.grant('campaign', s.campaign.id);
    const camp = await s.vendor.get<GrantView>(`/host/openwop-app/collab/grants/${gc.grantId}`);
    expect(camp.status, camp.raw).toBe(200);
    expect(camp.body).toMatchObject({ title: 'Spring roast launch', resource: { kind: 'campaign', objective: 'Sell 500 bags' } });
    expect(Object.keys(camp.body.resource).sort()).toEqual(['channels', 'kind', 'objective', 'status']);
    await transitionBrief(s.tenantId, s.orgId, s.brief.briefId, 'seed', 'draft');
    expect((await s.vendor.get(`/host/openwop-app/collab/grants/${gb.grantId}`)).status).toBe(404);
    expect((await s.vendor.get<Shared>('/host/openwop-app/collab/shared')).body.items.map((i) => i.grantId)).toEqual([gc.grantId]);
  });

  it('a revoked grant drops out at once; another user naming the grant gets 404', async () => {
    const s = await setup();
    const g = await s.grant('creative-brief', s.brief.briefId);
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${n}@elsewhere.test` });
    expect((await stranger.get(`/host/openwop-app/collab/grants/${g.grantId}`)).status).toBe(404);
    expect((await stranger.get<Shared>('/host/openwop-app/collab/shared')).body.items).toEqual([]);
    expect((await s.admin.del(`${s.C}/${s.collaborator.collaboratorId}/grants/${g.grantId}`)).status).toBe(200);
    expect((await s.vendor.get(`/host/openwop-app/collab/grants/${g.grantId}`)).status).toBe(404);
    expect((await s.vendor.get<Shared>('/host/openwop-app/collab/shared')).body.items).toEqual([]);
  });

  it('the owning feature turned off in the agency darkens the grant', async () => {
    const s = await setup();
    const g = await s.grant('creative-brief', s.brief.briefId);
    await setToggle('creative-briefs', false);
    try {
      expect((await s.vendor.get(`/host/openwop-app/collab/grants/${g.grantId}`)).status).toBe(404);
    } finally {
      await setToggle('creative-briefs', true);
    }
  });
});

describe('ADR 0958 D8 witness 1 — a collaborator session reaches nothing through agency routes', () => {
  it('every agency route naming the client is refused and leaks nothing', async () => {
    const s = await setup();
    await s.grant('creative-brief', s.brief.briefId);
    const probes = [
      `/host/openwop-app/campaign-ops/clients/${s.orgId}`,
      `/host/openwop-app/campaign-ops/clients/${s.orgId}/requests`,
      `/host/openwop-app/campaign-ops/clients/${s.orgId}/collaborators`,
      `/host/openwop-app/creative-briefs/orgs/${s.orgId}/briefs`,
      `/host/openwop-app/creative-briefs/orgs/${s.orgId}/briefs/${s.brief.briefId}`,
      `/host/openwop-app/campaign-orchestration/campaigns/${s.campaign.id}`,
      `/host/openwop-app/media/orgs/${s.orgId}/assets`,
      `/host/openwop-app/comments/orgs/${s.orgId}/comments?resourceType=creative_brief&resourceId=${s.brief.briefId}`,
    ];
    for (const p of probes) {
      const r = await s.vendor.get(p);
      expect([401, 403, 404], `${p} answered ${r.status}`).toContain(r.status);
      expect(r.raw, p).not.toContain(SECRET);
    }
    // The agency client list from the collaborator's own session names no agency client.
    const clients = await s.vendor.get('/host/openwop-app/campaign-ops/clients');
    expect(clients.raw).not.toContain('Northwind Coffee');
  });
});
