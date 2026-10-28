/**
 * ADR 0958 D2 — the two MEDIUMs the adversarial `/architect` pass recorded
 * (2026-10-26), through `createApp`, real sessions and the real routes.
 *
 *   - Un-archiving a client restored every unexpired grant with no decision.
 *     Archiving through the client route now SUSPENDS its signed-in
 *     collaborators (D7), so after un-archive the grant is still refused until
 *     an agency member reactivates the collaborator.
 *   - The bind CAS and its bound-index write were two writes with nothing to
 *     repair a missing index row. The index is now written first and re-put on
 *     the same-user retry, so a binding whose row went missing is found again
 *     ("Shared with me" lists it) the next time that person accepts.
 *
 * Sabotage notes (2026-10-27), each red when applied alone:
 *   - drop the `suspendCollaboratorsForOrg` call from the client route → the
 *     grant works again after un-archive (red);
 *   - drop the index re-put on the same-user path → the repair case red.
 *   - (Codex harness, 2026-10-27) catch every suspension failure → the
 *     injected-write-error case red (archive reported 200 over an active
 *     collaborator);
 *   - delete our index row whenever the bind is refused → the same-user
 *     interleaving case red (the binding vanished from "Shared with me");
 *   - delete it unconditionally after the retries run out → the
 *     exhausted-retries case red.
 * The interleavings are driven by wrapping `DurableCollection.compareAndSwap`:
 * a write error on the suspension, and a same-user win plus a suspend landing
 * between the bind's read and its CAS. A caller that loses to ANOTHER user
 * still deletes its row; a stray row would be harmless anyway, since every
 * reader re-checks `boundUserId` on the record.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { bindCollaborator, checkGrantUse, getCollaborator, setCollaboratorStatus, usableGrantsForUser, __boundIndexHasForTests, __dropBoundIndexRowForTests, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';

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
  const tenantId = `ws:t-d2m-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-d2m-${n}@agency.test`, tenantId });
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

/** A vendor who signed in and accepted, with a grant to upload. */
async function acceptedVendor(s: Awaited<ReturnType<typeof setup>>) {
  const vendor = client();
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `photographer-d2m-${n}@studio.test` });
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


type Cas = (this: unknown, expected: unknown, next: unknown) => Promise<boolean>;
const nameOf = (c: unknown): string => (c as { name: string }).name;

describe('ADR 0958 D2 MEDIUMs', () => {
  it('archiving a client suspends its signed-in collaborators; un-archiving restores nothing without a decision', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const use = () => checkGrantUse({ grantId: v.grant.grantId, via: { userId: v.userId }, action: 'view' });
    await expect(use()).resolves.toBeTruthy();
    const P = `/host/openwop-app/campaign-ops/clients/${s.orgId}`;
    expect((await s.admin.patch(P, { status: 'archived' })).status).toBe(200);
    expect((await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId))?.status).toBe('suspended');
    await expect(use()).rejects.toMatchObject({ httpStatus: 404 });
    expect((await s.admin.patch(P, { status: 'active' })).status).toBe(200);
    // Un-archived, the grant is still refused, and the vendor's list does not show it.
    await expect(use()).rejects.toMatchObject({ httpStatus: 404 });
    expect((await usableGrantsForUser(v.userId)).map((u) => u.grant.grantId)).not.toContain(v.grant.grantId);
    // An agency member's decision brings it back.
    await setCollaboratorStatus(s.tenantId, s.orgId, v.collaborator.collaboratorId, 'active', 'admin');
    await expect(use()).resolves.toBeTruthy();
  });

  it('a binding whose index row went missing is repaired by the same person accepting again', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const cid = v.collaborator.collaboratorId;
    expect(await __boundIndexHasForTests(v.userId, cid)).toBe(true);
    // The state a crash between the two writes used to leave: bound, but not indexed.
    await __dropBoundIndexRowForTests(v.userId, cid);
    expect((await usableGrantsForUser(v.userId)).map((u) => u.grant.grantId)).not.toContain(v.grant.grantId);
    await bindCollaborator(s.tenantId, s.orgId, cid, v.userId);
    expect(await __boundIndexHasForTests(v.userId, cid)).toBe(true);
    expect((await usableGrantsForUser(v.userId)).map((u) => u.grant.grantId)).toContain(v.grant.grantId);
    // Another user still cannot take the binding, and gets no index row.
    const other = client();
    const o = await other.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `other-d2m-${n}@studio.test` });
    await expect(bindCollaborator(s.tenantId, s.orgId, cid, o.body.user.userId)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await __boundIndexHasForTests(o.body.user.userId, cid)).toBe(false);
  });

  it('archive fails closed when a suspension cannot be written; a retry completes it', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const P = `/host/openwop-app/campaign-ops/clients/${s.orgId}`;
    const original = DurableCollection.prototype.compareAndSwap as unknown as Cas;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: unknown, expected: unknown, next: unknown) {
      if (nameOf(this) === 'extcollab:c' && (next as ExternalCollaborator | null)?.status === 'suspended') throw new Error('injected write error');
      return original.call(this, expected, next);
    } as never);
    try {
      const r = await s.admin.patch(P, { status: 'archived' });
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect((await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId))?.status).toBe('active');
    } finally { spy.mockRestore(); }
    expect((await s.admin.patch(P, { status: 'archived' })).status).toBe(200);
    expect((await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId))?.status).toBe('suspended');
  });

  it('a bind that loses to the SAME user, suspended since, keeps that binding indexed', async () => {
    const s = await setup();
    const email = `race-d2m-${n}@studio.test`;
    const inv = await s.invite(email);
    expect(inv.status, inv.raw).toBe(201);
    const cid = inv.body.collaborator.collaboratorId;
    const g = await s.grantFor(cid);
    const u = client();
    const userId = (await u.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email })).body.user.userId;
    const original = DurableCollection.prototype.compareAndSwap as unknown as Cas;
    let raced = false;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: unknown, expected: unknown, next: unknown) {
      const e = expected as ExternalCollaborator | null; const x = next as ExternalCollaborator;
      if (!raced && nameOf(this) === 'extcollab:c' && e?.status === 'invited' && x.boundUserId === userId) {
        raced = true;
        // Between our read and our CAS: the same user's other accept wins, then an archive suspends it.
        expect(await original.call(this, e, x)).toBe(true);
        expect(await original.call(this, x, { ...x, status: 'suspended' })).toBe(true);
        return false;
      }
      return original.call(this, expected, next);
    } as never);
    try {
      await expect(bindCollaborator(s.tenantId, s.orgId, cid, userId)).rejects.toMatchObject({ httpStatus: 404 });
    } finally { spy.mockRestore(); }
    expect(raced).toBe(true);
    expect(await __boundIndexHasForTests(userId, cid)).toBe(true);
    // Reactivated, the binding is found again: "Shared with me" lists the grant.
    await setCollaboratorStatus(s.tenantId, s.orgId, cid, 'active', 'admin');
    expect((await usableGrantsForUser(userId)).map((x) => x.grant.grantId)).toContain(g.grantId);
  });

  it('a bind that exhausts its retries keeps the row when the same user won the last race', async () => {
    const s = await setup();
    const email = `race3-d2m-${n}@studio.test`;
    const inv = await s.invite(email);
    expect(inv.status, inv.raw).toBe(201);
    const cid = inv.body.collaborator.collaboratorId;
    const u = client();
    const userId = (await u.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email })).body.user.userId;
    const original = DurableCollection.prototype.compareAndSwap as unknown as Cas;
    let losses = 0;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: unknown, expected: unknown, next: unknown) {
      const e = expected as ExternalCollaborator | null; const x = next as ExternalCollaborator;
      if (nameOf(this) === 'extcollab:c' && e?.status === 'invited' && x.boundUserId === userId) {
        losses += 1;
        // The third CAS loses to the same user's other accept.
        if (losses === 3) expect(await original.call(this, e, x)).toBe(true);
        return false;
      }
      return original.call(this, expected, next);
    } as never);
    try {
      await expect(bindCollaborator(s.tenantId, s.orgId, cid, userId)).rejects.toMatchObject({ httpStatus: 409 });
    } finally { spy.mockRestore(); }
    expect(losses).toBe(3);
    expect((await getCollaborator(s.tenantId, s.orgId, cid))?.boundUserId).toBe(userId);
    expect(await __boundIndexHasForTests(userId, cid)).toBe(true);
  });
});
