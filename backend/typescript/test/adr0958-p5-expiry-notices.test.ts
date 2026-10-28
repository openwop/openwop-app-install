/**
 * ADR 0958 D7 / P5 — expiry notices: the agency member who granted access is
 * told once, 7 days or less before it ends. Through `createApp`, real sessions
 * and the real grant route; the tick is driven by calling
 * `notifyExpiringGrants(now, collabEnabledFor)` with a chosen clock.
 *
 *   - A grant ending in 5 days is announced to its granter, once; a second
 *     tick sends nothing. The notice carries ids and dates, never the
 *     collaborator's name or email (it would outlive their erasure).
 *   - A 30-day grant is silent until 7 days are left, then announced.
 *   - Not announced: a revoked grant, a suspended collaborator, a grant
 *     already expired, or any grant while the tenant's external-collab toggle
 *     is off (or no toggle check was passed: fail closed).
 *
 * Sabotage notes (2026-10-27), each red when applied alone:
 *   - drop the `expiryNoticeAt` claim (no CAS) → the second tick notifies
 *     again (red);
 *   - widen the horizon to 30 days → the 30-day grant is announced on day 0 (red);
 *   - drop the collaborator-status check → the suspended case red;
 *   - put `displayName` in the title → the no-PII assertion red;
 *   - skip the `collaborationOn` check → the toggle-off case red.
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
import { notifyExpiringGrants, revokeGrant, setCollaboratorStatus, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { createMember } from '../src/host/accessControlService.js';
import { collabEnabledFor } from '../src/features/campaign-ops/collaboration/routes.js';

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


const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fixture-bytes-0001')]);
const pngNo = (i: number): Buffer => Buffer.concat([PNG, Buffer.from(`-${i}-${Math.random()}`)]);
const RIGHTS = { license: 'work-for-hire', modelReleases: true, credit: 'Dana Studio', attest: true };

let n = 0;
async function setup() {
  const tenantId = `ws:t-expiry-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-x-${n}@agency.test`, tenantId });
  expect(login.status).toBe(201);
  const adminUserId = login.body.user.userId;
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Northwind Coffee' });
  expect((await admin.post('/host/openwop-app/campaign-ops/clients', { name: 'Northwind Coffee', orgId: org.body.orgId })).status).toBe(201);
  const orgId = org.body.orgId;
  const cBrief = await createCampaignBrief(tenantId, orgId, 'seed', { name: 'Spring roast launch', objective: 'Sell 500 bags' });
  const campaign = await finalizeFromBrief(tenantId, cBrief, 'seed');
  const C = `/host/openwop-app/campaign-ops/clients/${orgId}/collaborators`;
  const A = `/host/openwop-app/campaign-ops/clients/${orgId}/intakes`;
  const invite = (email: string) => admin.post<{ collaborator: ExternalCollaborator; invite: { token: string } }>(C, { kind: 'vendor', email, displayName: 'Dana Studio' });
  const grantFor = async (collaboratorId: string, expiresInDays?: number): Promise<CollaboratorGrant> => {
    const r = await admin.post<{ grant: CollaboratorGrant }>(`${C}/${collaboratorId}/grants`, { resource: { kind: 'campaign', id: campaign.id }, actions: ['view', 'upload'], ...(expiresInDays ? { expiresInDays } : {}) });
    expect(r.status, r.raw).toBe(201);
    return r.body.grant;
  };
  return { tenantId, orgId, admin, adminUserId, C, A, invite, grantFor };
}

/** A vendor who signed in and accepted, with a grant to upload. */
async function acceptedVendor(s: Awaited<ReturnType<typeof setup>>) {
  const vendor = client();
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `photographer-x-${n}-${Math.random().toString(36).slice(2)}@studio.test` });
  const userId = v.body.user.userId;
  const email = (await getUser(userId))?.email ?? '';
  const inv = await s.invite(email);
  expect(inv.status, inv.raw).toBe(201);
  expect((await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const grant = await s.grantFor(inv.body.collaborator.collaboratorId, 5);
  const upload = (name: string, note?: string) => vendor.post<{ intake: { intakeId: string; files: Array<{ fileId: string }> } }>(
    `/host/openwop-app/collab/grants/${grant.grantId}/intakes`,
    { files: [{ name, contentType: 'image/png', contentBase64: pngNo(Math.random()).toString('base64') }], rights: RIGHTS, ...(note ? { note } : {}) },
  );
  return { vendor, userId, email, collaborator: inv.body.collaborator, grant, upload };
}


type Seen = { recipientUserId?: string; tenantId: string; title: string; message: string; metadata?: Record<string, unknown> };
function capture(tenantId: string) {
  const seen: Seen[] = [];
  const unsub = getNotificationEmitter().subscribe((x) => {
    const r = x as unknown as Seen & { type: string };
    if (r.type === 'collab.grant-expiring' && r.tenantId === tenantId) seen.push(r);
  });
  return { seen, unsub };
}
const DAY = 24 * 60 * 60 * 1000;

describe('ADR 0958 P5 — expiry notices', () => {
  it('announces a grant ending within 7 days to its granter, once, with no personal data', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const cap = capture(s.tenantId);
    try {
      await notifyExpiringGrants(new Date(), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen).toHaveLength(1);
      const n0 = cap.seen[0]!;
      expect(n0.recipientUserId).toBe(s.adminUserId);
      expect(n0.metadata).toMatchObject({ grantId: v.grant.grantId, collaboratorId: v.collaborator.collaboratorId, orgId: s.orgId });
      expect(JSON.stringify(n0)).not.toMatch(/Dana|@studio\.test/);
      await notifyExpiringGrants(new Date(Date.now() + DAY), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen).toHaveLength(1);
    } finally { cap.unsub(); }
  });

  it('a 30-day grant is silent until 7 days are left', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    await revokeGrant(s.tenantId, s.orgId, v.grant.grantId, 'admin'); // keep only the 30-day grant in play
    const g30 = await s.grantFor(v.collaborator.collaboratorId);
    const cap = capture(s.tenantId);
    try {
      await notifyExpiringGrants(new Date(), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen).toHaveLength(0);
      await notifyExpiringGrants(new Date(Date.parse(g30.expiresAt) - 6 * DAY), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen.map((x) => x.metadata?.grantId)).toEqual([g30.grantId]);
    } finally { cap.unsub(); }
  });

  it('is silent for a revoked grant, a suspended collaborator and an expired grant', async () => {
    const s = await setup();
    const revoked = await acceptedVendor(s);
    await revokeGrant(s.tenantId, s.orgId, revoked.grant.grantId, 'admin');
    const suspended = await acceptedVendor(s);
    await setCollaboratorStatus(s.tenantId, s.orgId, suspended.collaborator.collaboratorId, 'suspended', 'admin');
    const expired = await acceptedVendor(s);
    const cap = capture(s.tenantId);
    try {
      // Past `expired`'s end: nothing to announce for any of them.
      await notifyExpiringGrants(new Date(Date.parse(expired.grant.expiresAt) + 1000), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen).toHaveLength(0);
      // Now, before anything ended: only the live one is announced.
      await notifyExpiringGrants(new Date(), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen.map((x) => x.metadata?.grantId)).toEqual([expired.grant.grantId]);
    } finally { cap.unsub(); }
  });

  it('is silent when external collaboration is off for the tenant', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const cap = capture(s.tenantId);
    try {
      await notifyExpiringGrants(new Date(), async (t) => t !== s.tenantId && collabEnabledFor(t));
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen).toHaveLength(0);
      await notifyExpiringGrants(new Date());
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen).toHaveLength(0);
      // Back on: the grant was never claimed while off, so it is announced now.
      await notifyExpiringGrants(new Date(), collabEnabledFor);
      await new Promise((r) => setTimeout(r, 50));
      expect(cap.seen.map((x) => x.metadata?.grantId)).toEqual([v.grant.grantId]);
    } finally { cap.unsub(); }
  });

  it('the granter reads the notice through their real inbox, in the shared workspace', async () => {
    const s = await setup();
    expect(s.tenantId.startsWith('ws:')).toBe(true);
    const v = await acceptedVendor(s);
    await notifyExpiringGrants(new Date(), collabEnabledFor);
    const inbox = await s.admin.get<{ notifications: Array<{ type: string; recipientUserId?: string; metadata?: Record<string, unknown> }> }>('/host/openwop-app/notifications');
    expect(inbox.status, inbox.raw).toBe(200);
    const mine = inbox.body.notifications.filter((x) => x.type === 'collab.grant-expiring');
    expect(mine.map((x) => x.metadata?.grantId)).toEqual([v.grant.grantId]);
    // Not addressed to anyone else: another member of the workspace does not see it.
    const other = client();
    expect((await other.post('/host/openwop-app/test/login', { email: `member-x-${n}@agency.test`, tenantId: s.tenantId })).status).toBe(201);
    const theirs = await other.get<{ notifications: Array<{ type: string }> }>('/host/openwop-app/notifications');
    expect(theirs.body.notifications?.filter((x) => x.type === 'collab.grant-expiring') ?? []).toEqual([]);
  });

  it('a member who arrived the production way (personal login, member row, switch) reads it in the workspace', async () => {
    // The test-login seam with a tenantId mints a WORKSPACE-keyed user, so the
    // case above cannot tell `createdBy` from the inbox's subject. In production
    // a member signs in to their personal tenant, is a member row under that
    // home userId, and switches: the grant route then records the home userId
    // as `createdBy`, and the inbox in the workspace reads the member subject.
    const s = await setup();
    const v = await acceptedVendor(s);
    const m = client();
    const login = await m.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { subject: `oidc-granter-${n}`, displayName: 'Granter' });
    expect(login.status).toBeLessThan(300);
    const homeUserId = login.body.user.userId;
    await createMember({ orgId: s.tenantId, tenantId: s.tenantId, displayName: 'Granter', subject: homeUserId, roles: ['owner'] });
    const sw = await m.post(`/host/openwop-app/workspaces/${encodeURIComponent(s.tenantId)}/switch`);
    expect(sw.status, sw.raw).toBe(200);
    const r = await m.post<{ grant: CollaboratorGrant }>(`${s.C}/${v.collaborator.collaboratorId}/grants`, { resource: v.grant.resource, actions: ['view'], expiresInDays: 3 });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.grant.createdBy).toBe(homeUserId);
    await notifyExpiringGrants(new Date(), collabEnabledFor);
    const inbox = await m.get<{ notifications: Array<{ type: string; metadata?: Record<string, unknown> }> }>('/host/openwop-app/notifications');
    expect(inbox.status, inbox.raw).toBe(200);
    expect(inbox.body.notifications.filter((x) => x.type === 'collab.grant-expiring').map((x) => x.metadata?.grantId)).toEqual([r.body.grant.grantId]);
  });
});
