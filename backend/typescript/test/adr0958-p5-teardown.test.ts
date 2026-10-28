/**
 * ADR 0958 P5 — org teardown of external collaboration, through `createApp`,
 * real sessions and the real routes. Before this, `purgeCollaboratorsForOrg`
 * ran no feature hooks and the demo teardown purged only portal approvers, so
 * a vendor's record, grants and every intake row outlived the teardown and
 * kept the client org's deletion refused (the RI-7 refuse-while-populated rule).
 *
 *   - `purgeCollaborationForOrg` removes every collaborator of the org (vendor
 *     and never-accepted invite alike), its grants, its bound-index row (the
 *     vendor's "Shared with me" is empty), its invite link, and every intake
 *     row in any state, with the held bytes. An ACCEPTED file stays in the
 *     media library (that store's teardown owns it).
 *   - The org's RI-7 count drops back to what it was before any collaboration.
 *   - Another org's collaboration is untouched.
 *   - Under a legal hold on the tenant nothing is deleted.
 *
 * Sabotage notes (2026-10-27), each red when applied alone:
 *   - drop the purge-hook loop in `purgeCollaboratorsForOrg` → the invite
 *     link survives (red). The intake rows are still caught by the final
 *     org-wide intake sweep, which is there for intakes whose collaborator is
 *     already gone, so the hook is witnessed by the link alone;
 *   - skip accepted intakes in `purgeIntakesForOrg` → the accepted row
 *     survives and the RI-7 count stays up (red);
 *   - purge with `purgePortalForOrg` alone (the old demo teardown) → the
 *     vendor record survives (red);
 *   - drop the legal-hold check → the hold case red.
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
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import { resolveActiveResource } from '../src/features/sharing/sharingService.js';
import { getIntake, listIntakes, __heldBytesExistForTests } from '../src/features/campaign-ops/collaboration/intake.js';
import { purgeCollaborationForOrg } from '../src/features/campaign-ops/erasure.js';
import { countOrgHostExtRows } from '../src/host/hostExtPersistence.js';
import { listAssets } from '../src/features/media/mediaService.js';
import { getCollaborator, listCollaborators, listGrants, usableGrantsForUser, type CollaboratorGrant, type ExternalCollaborator } from '../src/host/externalCollaborators.js';

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
  const tenantId = `ws:t-teardown-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-td-${n}@agency.test`, tenantId });
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
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `photographer-td-${n}@studio.test` });
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


describe('ADR 0958 P5 — org teardown of external collaboration', () => {
  it('removes every collaborator, grant, invite link and intake of the org, and nothing else', async () => {
    const s = await setup();
    const other = await setup();
    const baseline = await countOrgHostExtRows(s.tenantId, s.orgId);
    const v = await acceptedVendor(s);
    const neverAccepted = await s.invite(`never-td-${n}@studio.test`);
    expect(neverAccepted.status).toBe(201);
    const kept = await v.upload('dana-kept.png', 'Dana note');
    const pending = await v.upload('dana-pending.png');
    const rejected = await v.upload('dana-rejected.png');
    expect([kept.status, pending.status, rejected.status]).toEqual([201, 201, 201]);
    const acc = await s.admin.post<{ assets: Array<{ assetId: string }> }>(`${s.A}/${kept.body.intake.intakeId}/accept`);
    expect(acc.status, acc.raw).toBe(200);
    expect((await s.admin.post(`${s.A}/${rejected.body.intake.intakeId}/reject`, { reason: 'off brief' })).status).toBe(200);
    const ov = await acceptedVendor(other);
    const otherUp = await ov.upload('other.png');
    expect(otherUp.status).toBe(201);
    const assetsBefore = (await listAssets(s.tenantId, s.orgId)).length;
    expect(await countOrgHostExtRows(s.tenantId, s.orgId)).toBeGreaterThan(baseline);

    expect(await purgeCollaborationForOrg(s.tenantId, s.orgId)).toBeGreaterThan(0);

    expect(await listCollaborators(s.tenantId, s.orgId)).toEqual([]);
    expect(await listGrants(s.tenantId, s.orgId)).toEqual([]);
    expect(await listIntakes(s.tenantId, s.orgId)).toEqual([]);
    expect((await usableGrantsForUser(v.userId)).filter((u) => u.tenantId === s.tenantId)).toEqual([]);
    for (const up of [pending, rejected]) {
      expect(await __heldBytesExistForTests(s.tenantId, s.orgId, up.body.intake.files[0]!.fileId)).toBe(false);
    }
    await expect(resolveActiveResource(neverAccepted.body.invite.token, 'collab_invite')).rejects.toThrow();
    // The accepted file is the media library's; it stays.
    expect(await getAssetByIdForTenant(s.tenantId, acc.body.assets[0]!.assetId)).not.toBeNull();
    expect((await listAssets(s.tenantId, s.orgId)).length).toBe(assetsBefore);
    // RI-7: what is left over the baseline is the media library's rows, nothing of collaboration's.
    const left = await countOrgHostExtRows(s.tenantId, s.orgId);
    const mediaOnly = await countOrgHostExtRows(s.tenantId, s.orgId, ['extcollab', 'campaign-ops:intake', 'sharing']);
    expect(left).toBe(mediaOnly);
    // Another org is untouched.
    expect(await getCollaborator(other.tenantId, other.orgId, ov.collaborator.collaboratorId)).not.toBeNull();
    expect((await getIntake(other.tenantId, other.orgId, otherUp.body.intake.intakeId))?.status).toBe('submitted');
    // A second run is a no-op.
    expect(await purgeCollaborationForOrg(s.tenantId, s.orgId)).toBe(0);
  });

  it('under a legal hold on the tenant nothing is deleted', async () => {
    const s = await setup();
    const v = await acceptedVendor(s);
    const up = await v.upload('dana-held.png');
    expect(up.status).toBe(201);
    await setRetentionHold(s.tenantId, 'litigation');
    try {
      expect(await purgeCollaborationForOrg(s.tenantId, s.orgId)).toBe(0);
      expect(await getCollaborator(s.tenantId, s.orgId, v.collaborator.collaboratorId)).not.toBeNull();
      expect((await getIntake(s.tenantId, s.orgId, up.body.intake.intakeId))?.status).toBe('submitted');
    } finally {
      await clearRetentionHold(s.tenantId);
    }
  });
});
