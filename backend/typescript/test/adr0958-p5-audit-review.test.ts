/**
 * ADR 0958 D7 / P5 — the audit review page's API: every collaboration event
 * the tenant's hash chain holds for one client, newest first. Through
 * `createApp`, real sessions and the real routes.
 *
 *   - Invite, accept, grant, a file sent and accepted, a grant revoked and a
 *     suspension appear, newest first, with the collaborator's live name.
 *   - Another client's events never appear.
 *   - Nothing personal is in the response beyond the live name: after the
 *     person is erased the events stay (the chain is the agency's record) and
 *     read as a removed collaborator, with no email or name anywhere.
 *   - Only an agency member who manages the client may read it (a vendor's
 *     session and a viewer are refused), and it is dark with the toggle off.
 *   - The chain read is bounded: newest first, `more` when older entries exist,
 *     at most 1,000 reads per load, issued 50 at a time in parallel (release
 *     review: 5,000 serial point reads would be seconds on Cloud SQL).
 *
 * Sabotage notes (2026-10-27), each red when applied alone:
 *   - drop the `orgId` filter → the other client's invite appears (red);
 *   - read the chain oldest first → the order assertion red;
 *   - return the payload whole instead of the projection → still green on
 *     names (the chain holds none, D7) but the `domain` key appears (red);
 *   - gate the route on `workspace:read` → the viewer case red;
 *   - read serially again → the cost case red (peak 1);
 *   - one Promise.all over the whole tail → the cost case red (peak > 50).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { createMember } from '../src/host/accessControlService.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { revokeGrant, setCollaboratorStatus, AUDIT_REVIEW_MAX_SCAN, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';
import { listChainTail, getAuditHead, CHAIN_TAIL_BATCH } from '../src/host/auditChainService.js';

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
  const tenantId = `ws:t-audit-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-au-${n}@agency.test`, tenantId });
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
  return { tenantId, orgId, otherOrgId: org2.body.orgId, admin, C, A, invite, grantFor };
}

/** A vendor who signed in and accepted, with a grant to upload. */
async function acceptedVendor(s: Awaited<ReturnType<typeof setup>>) {
  const vendor = client();
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `photographer-au-${n}-${Math.random().toString(36).slice(2)}@studio.test` });
  const userId = v.body.user.userId;
  const email = (await getUser(userId))?.email ?? '';
  const inv = await s.invite(email);
  expect(inv.status, inv.raw).toBe(201);
  expect((await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const grant = await s.grantFor(inv.body.collaborator.collaboratorId);
  const upload = (name: string, note?: string) => vendor.post<{ intake: { intakeId: string; files: Array<{ fileId: string }> } }>(
    `/host/openwop-app/collab/grants/${grant.grantId}/intakes`,
    { files: [{ name, contentType: 'image/png', contentBase64: pngNo(Math.random()).toString('base64') }], rights: RIGHTS, ...(note ? { note } : {}) },
  );
  return { vendor, userId, email, collaborator: inv.body.collaborator, grant, upload };
}


type AuditEvent = { seq: number; action: string; collaboratorId?: string; grantId?: string; intakeId?: string; collaborator: { displayName: string } | null; [k: string]: unknown };

describe('ADR 0958 P5 — the collaboration audit review', () => {
  it('lists the client’s events newest first with live names, and nothing from another client', async () => {
    const s = await setup();
    const other = await s.invite(`other-client-${n}@studio.test`.replace('@', `-${Math.random().toString(36).slice(2)}@`));
    expect(other.status).toBe(201);
    const v = await acceptedVendor(s);
    const up = await v.upload('dana-audit.png');
    expect(up.status, up.raw).toBe(201);
    expect((await s.admin.post(`${s.A}/${up.body.intake.intakeId}/accept`)).status).toBe(200);
    await revokeGrant(s.tenantId, s.orgId, v.grant.grantId, 'admin');
    await setCollaboratorStatus(s.tenantId, s.orgId, v.collaborator.collaboratorId, 'suspended', 'admin');
    // An event in the OTHER client of the same tenant.
    const o2 = await s.admin.post<{ collaborator: ExternalCollaborator }>(`/host/openwop-app/campaign-ops/clients/${s.otherOrgId}/collaborators`, { kind: 'vendor', email: `elsewhere-${n}@studio.test`, displayName: 'Elsewhere Ltd' });
    expect(o2.status, o2.raw).toBe(201);

    const r = await s.admin.get<{ events: AuditEvent[]; truncated: boolean }>(`${s.C}/audit`);
    expect(r.status, r.raw).toBe(200);
    const mine = r.body.events.filter((e) => e.collaboratorId === v.collaborator.collaboratorId).map((e) => e.action);
    expect(mine).toEqual(['collaborator.suspend', 'grant.revoke', 'intake.accept', 'intake.submit', 'grant.create', 'collaborator.accept', 'collaborator.invite']);
    const seqs = r.body.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(r.body.events.find((e) => e.action === 'collaborator.invite' && e.collaboratorId === v.collaborator.collaboratorId)?.collaborator?.displayName).toBe('Dana Studio');
    expect(r.body.events.some((e) => e.collaboratorId === o2.body.collaborator.collaboratorId)).toBe(false);
    expect(r.raw).not.toContain('"domain"');
    expect(r.body.truncated).toBe(false);
  });

  it('after the person is erased their events stay, as a removed collaborator, with nothing personal', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    expect((await eraseSubject(s.tenantId, v.email)).failed).toBe(0);
    const r = await s.admin.get<{ events: AuditEvent[] }>(`${s.C}/audit`);
    expect(r.status).toBe(200);
    const mine = r.body.events.filter((e) => e.collaboratorId === v.collaborator.collaboratorId);
    expect(mine.map((e) => e.action)).toContain('collaborator.invite');
    for (const e of mine) expect(e.collaborator).toBeNull();
    expect(r.raw).not.toContain(v.email);
    expect(r.raw).not.toContain('Dana');
  });

  it('only an agency member who manages the client may read it; dark with the toggle off', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    expect((await v.vendor.get(`${s.C}/audit`)).status).toBeGreaterThanOrEqual(403);
    const viewer = client();
    const vl = await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `viewer-au-${n}@agency.test` });
    await createMember({ orgId: s.tenantId, tenantId: s.tenantId, displayName: 'Viewer', subject: vl.body.user.userId, roles: ['viewer'] });
    // A viewer OF THIS CLIENT: it can read the client (workspace:read), so only
    // the manage scope refuses it here.
    await createMember({ orgId: s.orgId, tenantId: s.tenantId, displayName: 'Viewer', subject: vl.body.user.userId, roles: ['viewer'] });
    expect((await viewer.post(`/host/openwop-app/workspaces/${encodeURIComponent(s.tenantId)}/switch`)).status).toBe(200);
    // Control: the same viewer CAN read the client's intakes (workspace:read).
    expect((await viewer.get(s.A)).status).toBe(200);
    const vr = await viewer.get<{ error?: string }>(`${s.C}/audit`);
    expect(vr.status).toBe(403);
    expect(vr.raw).not.toMatch(/not enabled/i);
    expect(vr.raw).not.toContain('collaborator.');
    await setToggle('campaign-ops.external-collab', false);
    try {
      expect((await s.admin.get(`${s.C}/audit`)).status).toBe(404);
    } finally { await setToggle('campaign-ops.external-collab', true); }
  });

  it('the chain read is bounded and newest first', async () => {
    const s = await setup();
    await acceptedVendor(s);
    const head = await getAuditHead(s.tenantId);
    expect(head && head.seq).toBeGreaterThan(2);
    const tail = await listChainTail(s.tenantId, 2);
    expect(tail.entries.map((e) => e.seq)).toEqual([head!.seq, head!.seq - 1]);
    expect(tail.more).toBe(true);
    expect((await listChainTail(s.tenantId, head!.seq + 1)).more).toBe(false);
  });

  it('pins the cost: at most 1,000 chain reads per load, in parallel batches, never serial and never all at once', async () => {
    expect(AUDIT_REVIEW_MAX_SCAN).toBe(1_000);
    expect(CHAIN_TAIL_BATCH).toBe(50);
    const s = await setup();
    const v = await acceptedVendor(s);
    // A chain longer than one batch, so "all at once" would show as a peak above it.
    for (let i = 0; i < 70; i++) await setCollaboratorStatus(s.tenantId, s.orgId, v.collaborator.collaboratorId, i % 2 ? 'active' : 'suspended', 'admin');
    const head = (await getAuditHead(s.tenantId))!.seq;
    expect(head).toBeGreaterThan(CHAIN_TAIL_BATCH);
    const original = DurableCollection.prototype.get;
    let reads = 0; let inFlight = 0; let peak = 0;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: unknown, id: string) {
      if ((this as { name: string }).name !== 'cdp:audit-chain') return original.call(this as never, id);
      reads += 1; inFlight += 1; peak = Math.max(peak, inFlight);
      try { await new Promise((r) => setTimeout(r, 1)); return await original.call(this as never, id); } finally { inFlight -= 1; }
    } as never);
    try {
      const tail = await listChainTail(s.tenantId, head + 1);
      expect(tail.entries).toHaveLength(head + 1);
      expect(reads).toBe(head + 1);
      expect(peak).toBeGreaterThan(1);            // parallel, not one round trip at a time
      expect(peak).toBeLessThanOrEqual(CHAIN_TAIL_BATCH);
      reads = 0;
      await listChainTail(s.tenantId, 3);
      expect(reads).toBe(3);                      // the bound is the number of reads
    } finally { spy.mockRestore(); }
  });
});
