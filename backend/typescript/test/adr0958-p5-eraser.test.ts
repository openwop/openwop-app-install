/**
 * ADR 0958 P5 — erasing an external collaborator, through `createApp`, real
 * sessions, the real routes and the real DSAR fan-out (`eraseSubject`).
 *
 *   - The AGENCY's erasure keyed by email (a person who never accepted): the
 *     collaborator record goes, its grants are revoked, and the invite link no
 *     longer resolves.
 *   - The exit criterion: an ACCEPTED vendor file stays in the library with the
 *     supplier anonymized. The intake row is kept (the agency's record, with the
 *     licence), minus the note, the credit and the vendor's file names; the
 *     asset's rights summary loses the credit and its name loses the vendor's
 *     file name. `suppliedBy` keeps its opaque ids, which resolve to nothing.
 *   - Files that were never accepted (awaiting review, rejected) are deleted
 *     with their held bytes.
 *   - The home-tenant erasure (P0, keyed by userId) takes the same intake path
 *     in the agency, so the cleanup never depends on eraser order.
 *   - Isolation: the same email erased in ANOTHER tenant touches nothing here,
 *     and a different email touches nothing.
 *   - A legal hold on the AGENCY (which the home-tenant DSAR's own hold check
 *     never sees): access ends (grant revoked), but the record and the intake
 *     are kept for the hold.
 *
 * Sabotage notes (2026-10-27), each red when applied alone:
 *   - skip the email half of the host eraser → the never-accepted case red;
 *   - delete accepted intakes instead of redacting them → the exit-criterion
 *     case red (the asset and the row must survive);
 *   - leave `rights.credit` on the intake → the exit-criterion case red;
 *   - drop the `eraseSupplierDetails` call → the asset's rights summary still
 *     names the credit (red);
 *   - skip the invite-link purge → the invite link still resolves (red);
 *   - match collaborators in every tenant instead of `tenantId` → the
 *     isolation case red;
 *   - ignore the agency's hold → the hold case red.
 * Stated, NOT witnessed: a pending intake is closed by CAS before it is
 * deleted, so an accept racing the erasure fails its final CAS and rolls back
 * (or wins, and the retry treats the intake as accepted). That window needs
 * two writers interleaved between a read and a CAS, which this test cannot time.
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
import { getAssetByIdForTenant } from '../src/features/media/mediaService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import { resolveActiveResource } from '../src/features/sharing/sharingService.js';
import { getIntake, __heldBytesExistForTests } from '../src/features/campaign-ops/collaboration/intake.js';
import { getCollaborator, listGrants, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';

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
  const tenantId = `ws:t-erase-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-e-${n}@agency.test`, tenantId });
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
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `photographer-e-${n}@studio.test` });
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

describe('ADR 0958 P5 — the agency erases a collaborator by email', () => {
  it('a never-accepted invite: the record goes, its grants are revoked, the invite link is dead', async () => {
    const s = await setup();
    const email = `never-accepted-${n}@studio.test`;
    const inv = await s.invite(email);
    expect(inv.status, inv.raw).toBe(201);
    const c = inv.body.collaborator;
    const g = await s.grantFor(c.collaboratorId);
    const token = inv.body.invite.token;
    expect((await resolveActiveResource(token, 'collab_invite')).resourceId).toBe(c.collaboratorId);

    const r = await eraseSubject(s.tenantId, email);
    expect(r.failed, JSON.stringify(r.failedFeatures)).toBe(0);
    expect(await getCollaborator(s.tenantId, s.orgId, c.collaboratorId)).toBeNull();
    const after = (await listGrants(s.tenantId, s.orgId)).find((x) => x.grantId === g.grantId);
    expect(after?.status).toBe('revoked');
    expect(after?.revokedBy).toBe('system:erasure');
    await expect(resolveActiveResource(token, 'collab_invite')).rejects.toThrow();
  });

  it('exit criterion: an accepted file stays with the supplier anonymized; files never taken are deleted', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const kept = await v.upload('dana-hero.png', 'Shot by Dana at the roastery');
    const pending = await v.upload('dana-pending.png', 'Second take');
    const rejected = await v.upload('dana-rejected.png');
    expect([kept.status, pending.status, rejected.status]).toEqual([201, 201, 201]);
    const acc = await s.admin.post<{ assets: Array<{ assetId: string }> }>(`${s.A}/${kept.body.intake.intakeId}/accept`);
    expect(acc.status, acc.raw).toBe(200);
    expect((await s.admin.post(`${s.A}/${rejected.body.intake.intakeId}/reject`, { reason: 'off brief' })).status).toBe(200);
    const assetId = acc.body.assets[0]!.assetId;
    const before = await getAssetByIdForTenant(s.tenantId, assetId);
    expect(before?.name).toBe('dana-hero.png');
    expect(before?.lineage?.rightsNote).toContain('Dana Studio');

    const r = await eraseSubject(s.tenantId, v.email);
    expect(r.failed, JSON.stringify(r.failedFeatures)).toBe(0);

    // The record is gone; the accepted file is still in the library, without the person.
    expect(await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId)).toBeNull();
    const asset = await getAssetByIdForTenant(s.tenantId, assetId);
    expect(asset).not.toBeNull();
    expect(asset!.name).toBe('vendor-file-1.png');
    expect(asset!.lineage?.rightsNote).toContain('work-for-hire');
    expect(asset!.lineage?.rightsNote).not.toContain('Dana');
    expect(asset!.lineage?.suppliedBy?.intakeId).toBe(kept.body.intake.intakeId);
    const row = await getIntake(s.tenantId, s.orgId, kept.body.intake.intakeId);
    expect(row?.status).toBe('accepted');
    expect(row?.rights.license).toBe('work-for-hire');
    expect(row?.supplierErasedAt).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/Dana|roastery/);

    // Never taken: the row and the held bytes are gone.
    for (const up of [pending, rejected]) {
      expect(await getIntake(s.tenantId, s.orgId, up.body.intake.intakeId)).toBeNull();
      expect(await __heldBytesExistForTests(s.tenantId, s.orgId, up.body.intake.files[0]!.fileId)).toBe(false);
    }
    // A second run is a no-op that still succeeds.
    expect((await eraseSubject(s.tenantId, v.email)).failed).toBe(0);
  });

  it('the home-tenant erasure (P0) takes the same intake path in the agency', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const kept = await v.upload('dana-home.png', 'Dana note');
    const acc = await s.admin.post<{ assets: Array<{ assetId: string }> }>(`${s.A}/${kept.body.intake.intakeId}/accept`);
    expect(acc.status, acc.raw).toBe(200);
    const home = (await getUser(v.userId))?.tenantId;
    expect(home).toBeTruthy();

    const r = await eraseSubject(home!, v.userId);
    expect(r.failed, JSON.stringify(r.failedFeatures)).toBe(0);
    expect(await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId)).toBeNull();
    const row = await getIntake(s.tenantId, s.orgId, kept.body.intake.intakeId);
    expect(row?.supplierErasedAt).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('Dana');
    expect((await getAssetByIdForTenant(s.tenantId, acc.body.assets[0]!.assetId))?.lineage?.rightsNote).not.toContain('Dana');
  });

  it('isolation: the same email erased in another tenant, or another email here, touches nothing', async () => {
    const s = await setup();
    const other = await setup();
    const v = await acceptedVendor(s);
    const up = await v.upload('dana-iso.png', 'Dana note');
    expect(up.status).toBe(201);

    expect((await eraseSubject(other.tenantId, v.email)).failed).toBe(0);
    expect((await eraseSubject(s.tenantId, `someone-else-${n}@studio.test`)).failed).toBe(0);
    expect(await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId)).not.toBeNull();
    const row = await getIntake(s.tenantId, s.orgId, up.body.intake.intakeId);
    expect(row?.note).toBe('Dana note');
    expect((await listGrants(s.tenantId, s.orgId)).find((g) => g.grantId === v.grant.grantId)?.status).toBe('active');
  });

  it('a legal hold on the agency keeps the record and the intake, but ends access', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const up = await v.upload('dana-held.png', 'Dana held note');
    expect(up.status).toBe(201);
    const home = (await getUser(v.userId))?.tenantId;
    await setRetentionHold(s.tenantId, 'litigation');
    try {
      const r = await eraseSubject(home!, v.userId);
      expect(r.failed, JSON.stringify(r.failedFeatures)).toBe(0);
      expect(await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId)).not.toBeNull();
      expect((await getIntake(s.tenantId, s.orgId, up.body.intake.intakeId))?.note).toBe('Dana held note');
      expect((await listGrants(s.tenantId, s.orgId)).find((g) => g.grantId === v.grant.grantId)?.status).toBe('revoked');
    } finally {
      await clearRetentionHold(s.tenantId);
    }
  });
});
