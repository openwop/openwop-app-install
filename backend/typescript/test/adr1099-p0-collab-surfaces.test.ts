/**
 * ADR 1099 P0 — collaboration surfaces (D1) and the collaborator routes in the
 * host route table (D2), with no behaviour change for ADR 0958's kinds.
 *
 * A grant kind that brings its OWN surface works in an org with NO campaign-ops
 * client account: the invite is accepted over the real route, the grant is
 * served through `/collab/grants/:id` and listed in "Shared with me". In the same
 * org, a `campaign` grant (default surface: campaign-ops' toggles and an active
 * client) is still refused, so a kind surface never widens another kind. Turning
 * the kind's surface off darkens its grant, and an org it does not admit refuses
 * every use.
 *
 * Everything ADR 0958 pinned before 1099 is still pinned by its own tests
 * (adr0958-*), which exercise the moved routes over HTTP unchanged.
 *
 * Sabotage notes: checking the DEFAULT surface instead of the kind's in
 * `checkGrantUse` reds the first case (a probe grant in a client-less org is
 * refused); checking ANY surface instead of the kind's in `grantAccess` reds the
 * second (the campaign grant is minted).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { createLink } from '../src/features/sharing/sharingService.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import {
  checkGrantUse, createCollaborator, grantAccess, registerGrantResourceKind, type CollaboratorGrant,
} from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;
const probeOn = new Set<string>();
const probeOrgs = new Set<string>();
const PROBE = 'p0-probe';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'campaign-brief', 'campaign-orchestration', 'campaign-ops', 'campaign-ops.external-collab']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // A kind with its OWN surface: on per tenant, open per org, exactly as the test says.
  registerGrantResourceKind(PROBE, {
    featureId: null,
    actions: ['view'],
    async exists() { return true; },
    async project() { return { title: 'Probe resource', body: { ok: true } }; },
    surface: {
      async enabledFor(tenantId) { return probeOn.has(tenantId); },
      async orgOpen(tenantId, orgId) { return probeOrgs.has(`${tenantId}:${orgId}`); },
    },
  });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
/** A workspace and an org with NO campaign-ops client account, and an accepted
 *  collaborator, accepted through the real host route under the probe surface. */
async function setup() {
  const tenantId = `ws:t-1099-${n++}`;
  const admin = client();
  const a = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `firm-${n}@firm.test`, tenantId });
  expect(a.status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const orgId = org.body.orgId;
  probeOn.add(tenantId);
  probeOrgs.add(`${tenantId}:${orgId}`);
  const visitor = client();
  const v = await visitor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `client-${n}@home.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const collaborator = await createCollaborator({ tenantId, orgId, kind: 'client-stakeholder', email, displayName: 'Casey Client', createdBy: a.body.user.userId });
  const link = await createLink(tenantId, orgId, 'system:adr1099-test', { resourceType: 'collab_invite', resourceId: collaborator.collaboratorId });
  const accepted = await visitor.post('/host/openwop-app/collab/invites/accept', { token: link.token });
  expect(accepted.status, accepted.raw).toBe(200);
  return { tenantId, orgId, adminId: a.body.user.userId, visitor, visitorId: v.body.user.userId, collaborator };
}

describe('ADR 1099 P0 — a kind with its own surface', () => {
  it('works in an org with no client account: invite accepted, grant served and listed', async () => {
    const s = await setup();
    const grant: CollaboratorGrant = await grantAccess({ tenantId: s.tenantId, orgId: s.orgId, collaboratorId: s.collaborator.collaboratorId, resource: { kind: PROBE, id: 'r1' }, actions: ['view'], createdBy: s.adminId });
    const view = await s.visitor.get<{ title: string; resource: Record<string, unknown> }>(`/host/openwop-app/collab/grants/${grant.grantId}`);
    expect(view.status, view.raw).toBe(200);
    expect(view.body).toMatchObject({ title: 'Probe resource', resource: { ok: true } });
    const shared = await s.visitor.get<{ items: Array<{ grantId: string }> }>('/host/openwop-app/collab/shared');
    expect(shared.body.items.map((i) => i.grantId)).toEqual([grant.grantId]);
  });

  it('never widens another kind: a campaign grant in the same org is refused (the default surface needs a client)', async () => {
    const s = await setup();
    // A REAL campaign in this org, so only the surface check can refuse it.
    const cBrief = await createCampaignBrief(s.tenantId, s.orgId, 'seed', { name: 'Kitchen refresh', objective: 'Book three consults' });
    const campaign = await finalizeFromBrief(s.tenantId, cBrief, 'seed');
    await expect(grantAccess({ tenantId: s.tenantId, orgId: s.orgId, collaboratorId: s.collaborator.collaboratorId, resource: { kind: 'campaign', id: campaign.id }, actions: ['view'], createdBy: s.adminId }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('the surface switched off darkens the grant; an org it no longer admits refuses every use', async () => {
    const s = await setup();
    const grant = await grantAccess({ tenantId: s.tenantId, orgId: s.orgId, collaboratorId: s.collaborator.collaboratorId, resource: { kind: PROBE, id: 'r2' }, actions: ['view'], createdBy: s.adminId });
    probeOn.delete(s.tenantId);
    expect((await s.visitor.get(`/host/openwop-app/collab/grants/${grant.grantId}`)).status).toBe(404);
    expect((await s.visitor.get<{ items: unknown[] }>('/host/openwop-app/collab/shared')).body.items).toEqual([]);
    probeOn.add(s.tenantId);
    probeOrgs.delete(`${s.tenantId}:${s.orgId}`);
    await expect(checkGrantUse({ grantId: grant.grantId, via: { userId: s.visitorId }, action: 'view' }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect((await s.visitor.get(`/host/openwop-app/collab/grants/${grant.grantId}`)).status).toBe(404);
  });
});
