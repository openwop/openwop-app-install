/**
 * ADR 0958 P3 — vendor asset intake, through `createApp`, real sessions and the
 * real routes.
 *
 *   - Witness 5 (D8), by absence: a pending file is not a media asset. It mints
 *     no serve token (the byte store is unchanged), is in no library list,
 *     select or tenant-wide read, and no lookup by token finds it. Its one read
 *     is the agency review download, for members who may accept, sent as an
 *     attachment under a sandbox CSP. The vendor can never read a file back.
 *   - Accept makes it an ordinary library asset with the write-once
 *     `lineage.suppliedBy` and the rights summary, served by the token route
 *     with the ADR 0818 headers; the held bytes are gone.
 *   - Active or mislabelled content is refused at the writer (SVG, HTML as an
 *     image or a video, a PDF without its header, a ZIP), and nothing is stored.
 *   - The scan port fails closed: infected and scanner-fault refuse the upload;
 *     a file stored with no scanner is scanned at accept.
 *   - Isolation: another org's or tenant's admin, a client-org viewer, a
 *     stranger, a view-only grant, another grant of the same person and a
 *     revoked grant are each refused; every agency miss is the same 404.
 *   - Reject keeps the bytes 30 days, then the default-window sweep purges them
 *     (not under a legal hold); withdraw drops them at once.
 *   - A concurrent second accept is refused and makes no second asset.
 *   - Census: only the agency route reaches `acceptIntake`; no node, tool or pack.
 *   - An accept that fails halfway leaves no library asset behind (rollback).
 *   - The campaign's ADR 0942 rule for `asset.accept-vendor` governs the human
 *     accept: blocked refuses, approve admits only a named approver, a
 *     multi-approver rule is refused rather than met by one click.
 *   - An archived campaign takes no files (the grant page's own rule).
 *
 * Sabotage notes (2026-10-26), each red when applied alone:
 *   - store pending bytes through `mediaStorage.put` (a token) → witness 5 red;
 *   - drop the magic-byte check for video → the HTML-as-MP4 case red;
 *   - let `scanUpload` errors pass as `not_configured` → the fault case red;
 *   - drop the `grantId` filter in `listIntakesForGrant` → the other-grant case red;
 *   - ignore an in-flight accept claim → the concurrency case red (the second
 *     accept is not refused `intake_busy`);
 *   - let a lineage patch clear `suppliedBy` → the write-once case red;
 *   - skip the legal-hold check in the sweep → the hold case red;
 *   - send the review download inline → witness 5 red;
 *   - drop the rollback of a partial accept → the rollback case red;
 *   - skip the autonomy rule in accept → the policy case red;
 *   - drop the projection check on upload → the archived case red;
 *   - skip removing a crashed accept's assets on reject → the crash case red.
 * Stayed green, and NOT claimed: writing the claim with a plain put instead of
 * a CAS. That only matters when two accepts both read the row before either
 * writes, a window this test cannot time; the busy check above is what it
 * witnesses. A crash-retry or a racing accept that does get through also finds
 * the bytes already in the library by hash and links them, so no duplicate
 * asset follows either way.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { createBrief as createCampaignBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief, updateCampaignStatus } from '../src/features/campaign-orchestration/campaignService.js';
import { createMember } from '../src/host/accessControlService.js';
import { listMediaAssetTokens } from '../src/host/inMemorySurfaces.js';
import { createAsset, getAssetByIdForTenant, listAssets, listAssetsForTenant, getAssetByServeTokenForTenant } from '../src/features/media/mediaService.js';
import { registerUploadScanner } from '../src/host/uploadScan.js';
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import { sweepRejectedIntakeBytes, __heldBytesExistForTests } from '../src/features/campaign-ops/collaboration/intake.js';
import type { CollaboratorGrant, ExternalCollaborator } from '../src/host/externalCollaborators.js';

// A controllable byte-store fault: `put` fails on the Nth call after arming, so a
// multi-file accept can be broken halfway (the rollback case). Pass-through otherwise.
const fault = vi.hoisted(() => ({ failAfter: -1 }));
vi.mock('../src/features/media/mediaStorage.js', async (orig) => {
  const real = await orig<typeof import('../src/features/media/mediaStorage.js')>();
  return {
    ...real,
    put: async (...args: Parameters<typeof real.put>) => {
      if (fault.failAfter === 0) { fault.failAfter = -1; throw new Error('byte store down'); }
      if (fault.failAfter > 0) fault.failAfter -= 1;
      return real.put(...args);
    },
  };
});

let BASE: string;
let server: http.Server;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

beforeAll(async () => {
  // ADR 0958 Q2 — outsider uploads need a scanner; this suite drives the unscanned
  // path deliberately, under the development waiver (the guard has its own leg).
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
afterEach(() => { registerUploadScanner(null); });

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

// Real file headers, so the magic-byte checks see what a browser upload sends.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fixture-bytes-0001')]);
const pngNo = (i: number): Buffer => Buffer.concat([PNG, Buffer.from(`-${i}-${Math.random()}`)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16, 1)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF');
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
const b64 = (b: Buffer): string => b.toString('base64');
const RIGHTS = { license: 'work-for-hire', modelReleases: true, credit: 'Dana Studio', attest: true };

let n = 0;
async function setup() {
  const tenantId = `ws:t-intake-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `agency-i-${n}@agency.test`, tenantId });
  expect(login.status).toBe(201);
  const adminUserId = login.body.user.userId;
  const mkClient = async (name: string): Promise<string> => {
    const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name });
    expect((await admin.post('/host/openwop-app/campaign-ops/clients', { name, orgId: org.body.orgId })).status).toBe(201);
    return org.body.orgId;
  };
  const orgId = await mkClient('Northwind Coffee');
  const otherOrgId = await mkClient('Contoso Tea');
  const cBrief = await createCampaignBrief(tenantId, orgId, 'seed', { name: 'Spring roast launch', objective: 'Sell 500 bags' });
  const campaign = await finalizeFromBrief(tenantId, cBrief, 'seed');
  const vendor = client();
  const v = await vendor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `photographer-${n}@studio.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const C = `/host/openwop-app/campaign-ops/clients/${orgId}/collaborators`;
  const inv = await admin.post<{ collaborator: ExternalCollaborator; invite: { token: string } }>(C, { kind: 'vendor', email, displayName: 'Dana Studio' });
  expect((await vendor.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const grant = async (actions: string[] = ['view', 'upload']): Promise<CollaboratorGrant> => {
    const r = await admin.post<{ grant: CollaboratorGrant }>(`${C}/${inv.body.collaborator.collaboratorId}/grants`, { resource: { kind: 'campaign', id: campaign.id }, actions });
    expect(r.status, r.raw).toBe(201);
    return r.body.grant;
  };
  const A = `/host/openwop-app/campaign-ops/clients/${orgId}/intakes`;
  const upload = (g: CollaboratorGrant, files: Array<{ name: string; contentType: string; buf: Buffer }>, rights: Record<string, unknown> = RIGHTS) =>
    vendor.post<{ intake: { intakeId: string; status: string; files: Array<{ fileId: string; name: string; contentType: string }> } }>(
      `/host/openwop-app/collab/grants/${g.grantId}/intakes`,
      { files: files.map((f) => ({ name: f.name, contentType: f.contentType, contentBase64: b64(f.buf) })), rights },
    );
  return { tenantId, orgId, otherOrgId, admin, adminUserId, vendor, campaign, collaborator: inv.body.collaborator, grant, upload, A, C };
}

describe('ADR 0958 D8 witness 5 — a pending file is reachable through no door', () => {
  it('mints no token, is in no library read, and the vendor cannot read it back; accept makes it a served asset', async () => {
    const s = await setup();
    const g = await s.grant();
    const tokensBefore = (await listMediaAssetTokens(s.tenantId)).length;
    const up = await s.upload(g, [{ name: 'hero.png', contentType: 'image/png', buf: pngNo(1) }]);
    expect(up.status, up.raw).toBe(201);
    expect(up.body.intake.status).toBe('submitted');
    // Nothing in the vendor's answer names a token, a URL or an agency id.
    expect(up.raw).not.toMatch(/token|serveUrl|\/assets\//i);
    expect(up.raw).not.toContain(s.tenantId);
    expect(up.raw).not.toContain(s.orgId);
    const intakeId = up.body.intake.intakeId;
    const fileId = up.body.intake.files[0]!.fileId;

    // No serve token was minted, so the public token route has nothing to serve.
    expect((await listMediaAssetTokens(s.tenantId)).length).toBe(tokensBefore);
    // Not in the library (the media picker), not selectable, not in the tenant-wide reads.
    expect(await listAssets(s.tenantId, s.orgId)).toEqual([]);
    expect(await listAssetsForTenant(s.tenantId)).toEqual([]);
    const lib = await s.admin.get<{ assets: unknown[] }>(`/host/openwop-app/media/orgs/${s.orgId}/assets`);
    expect(lib.status).toBe(200);
    expect(lib.body.assets).toEqual([]);
    const sel = await s.admin.post<{ assets?: unknown[]; ranked?: unknown[] }>(`/host/openwop-app/media/orgs/${s.orgId}/assets/select`, {});
    expect(sel.raw).not.toContain('hero.png');
    // The vendor has no byte route: every plausible path is a refusal.
    for (const p of [
      `/host/openwop-app/collab/grants/${g.grantId}/intakes/${intakeId}`,
      `/host/openwop-app/collab/grants/${g.grantId}/intakes/${intakeId}/files/${fileId}`,
      `${s.A}/${intakeId}/files/${fileId}`,
    ]) {
      const r = await s.vendor.get(p);
      expect([401, 403, 404], `${p} answered ${r.status}`).toContain(r.status);
      expect(r.raw).not.toContain('IHDR-fixture');
    }
    // Anonymous: no session, no door.
    const anon = await fetch(`${BASE}${s.A}/${intakeId}/files/${fileId}`);
    expect([401, 403, 404]).toContain(anon.status);

    // The agency review download: an attachment, sandboxed, never cached.
    const dl = await s.admin.get(`${s.A}/${intakeId}/files/${fileId}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toBe('attachment');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-security-policy')).toContain('sandbox');
    expect(dl.headers.get('cache-control')).toBe('private, no-store');

    // Accept: an ordinary library asset with the supplier and the rights summary.
    const acc = await s.admin.post<{ assets: Array<{ assetId: string; serveUrl: string; serveToken: string }> }>(`${s.A}/${intakeId}/accept`);
    expect(acc.status, acc.raw).toBe(200);
    const asset = await getAssetByIdForTenant(s.tenantId, acc.body.assets[0]!.assetId);
    expect(asset?.orgId).toBe(s.orgId);
    expect(asset?.lineage?.suppliedBy).toEqual({ kind: 'vendor', collaboratorId: s.collaborator.collaboratorId, grantId: g.grantId, intakeId });
    expect(asset?.lineage?.rightsNote).toContain('work-for-hire');
    expect(await getAssetByServeTokenForTenant(s.tenantId, asset!.serveToken)).not.toBeNull();
    const served = await fetch(`${BASE}${acc.body.assets[0]!.serveUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    // The held bytes are gone, and the review download is closed.
    expect(await __heldBytesExistForTests(s.tenantId, s.orgId, fileId)).toBe(false);
    expect((await s.admin.get(`${s.A}/${intakeId}/files/${fileId}`)).status).toBe(404);
    // The vendor sees the outcome but not the asset.
    const mine = await s.vendor.get<{ intakes: Array<{ status: string }> }>(`/host/openwop-app/collab/grants/${g.grantId}/intakes`);
    expect(mine.body.intakes[0]!.status).toBe('accepted');
    expect(mine.raw).not.toContain(asset!.assetId);
    expect(mine.raw).not.toContain(asset!.serveToken);
  });

  it('a patch can neither clear nor forge suppliedBy', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'a.png', contentType: 'image/png', buf: pngNo(2) }]);
    const acc = await s.admin.post<{ assets: Array<{ assetId: string }> }>(`${s.A}/${up.body.intake.intakeId}/accept`);
    const id = acc.body.assets[0]!.assetId;
    const M = `/host/openwop-app/media/orgs/${s.orgId}/assets`;
    expect((await s.admin.patch(`${M}/${id}`, { lineage: null })).status).toBe(200);
    expect((await getAssetByIdForTenant(s.tenantId, id))?.lineage?.suppliedBy?.collaboratorId).toBe(s.collaborator.collaboratorId);
    // An agency member's own upload cannot claim a vendor supplied it.
    const own = await s.admin.post<{ assetId: string }>(M, { name: 'own.png', contentType: 'image/png', contentBase64: b64(pngNo(3)), lineage: { suppliedBy: { kind: 'vendor', collaboratorId: 'ccb_x', grantId: 'cgr_x', intakeId: 'intk_x' } } });
    expect(own.status, own.raw).toBe(201);
    expect((await getAssetByIdForTenant(s.tenantId, own.body.assetId))?.lineage?.suppliedBy).toBeUndefined();
    await s.admin.patch(`${M}/${own.body.assetId}`, { lineage: { suppliedBy: { kind: 'vendor', collaboratorId: 'ccb_x', grantId: 'cgr_x', intakeId: 'intk_x' } } });
    expect((await getAssetByIdForTenant(s.tenantId, own.body.assetId))?.lineage?.suppliedBy).toBeUndefined();
  });
});

describe('ADR 0958 P3 — the writer refuses active or mislabelled content', () => {
  it('SVG, HTML as an image or a video, a header-less PDF and a ZIP are refused and nothing is stored', async () => {
    const s = await setup();
    const g = await s.grant();
    const cases: Array<{ name: string; contentType: string; buf: Buffer }> = [
      { name: 'x.svg', contentType: 'image/svg+xml', buf: SVG },
      { name: 'x.png', contentType: 'image/png', buf: HTML },
      { name: 'x.mp4', contentType: 'video/mp4', buf: HTML },
      { name: 'x.webm', contentType: 'video/webm', buf: HTML },
      { name: 'x.html', contentType: 'text/html', buf: HTML },
      { name: 'x.pdf', contentType: 'application/pdf', buf: HTML },
      { name: 'x.zip', contentType: 'application/zip', buf: ZIP },
      { name: 'x.txt', contentType: 'text/plain', buf: Buffer.from('hello') },
    ];
    for (const c of cases) {
      const r = await s.upload(g, [c]);
      expect(r.status, `${c.name} as ${c.contentType}: ${r.raw}`).toBe(415);
    }
    // One bad file refuses the whole upload: the good one beside it is not stored either.
    expect((await s.upload(g, [{ name: 'ok.png', contentType: 'image/png', buf: pngNo(4) }, { name: 'bad.png', contentType: 'image/png', buf: HTML }])).status).toBe(415);
    const mine = await s.vendor.get<{ intakes: unknown[] }>(`/host/openwop-app/collab/grants/${g.grantId}/intakes`);
    expect(mine.body.intakes).toEqual([]);
    // The real types are accepted, and a mislabelled image is stored as what it is.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif-fixture')]);
    const ok = await s.upload(g, [
      { name: 'clip.mp4', contentType: 'video/mp4', buf: MP4 },
      { name: 'spec.pdf', contentType: 'application/pdf', buf: PDF },
      { name: 'photo.png', contentType: 'image/png', buf: jpeg },
    ]);
    expect(ok.status, ok.raw).toBe(201);
    expect(ok.body.intake.files.map((f) => f.contentType)).toEqual(['video/mp4', 'application/pdf', 'image/jpeg']);
  });

  it('rights are required: a licence, the model-release answer and the attestation; a term licence needs a future end date', async () => {
    const s = await setup();
    const g = await s.grant();
    const f = [{ name: 'r.png', contentType: 'image/png', buf: pngNo(5) }];
    expect((await s.upload(g, f, { ...RIGHTS, license: 'whatever' })).status).toBe(400);
    expect((await s.upload(g, f, { ...RIGHTS, attest: false })).status).toBe(400);
    expect((await s.upload(g, f, { license: 'stock', attest: true })).status).toBe(400);
    expect((await s.upload(g, f, { ...RIGHTS, license: 'licensed-term' })).status).toBe(400);
    expect((await s.upload(g, f, { ...RIGHTS, license: 'licensed-term', termEndsAt: '2001-01-01' })).status).toBe(400);
    const ok = await s.upload(g, f, { ...RIGHTS, license: 'licensed-term', termEndsAt: '2099-12-31' });
    expect(ok.status, ok.raw).toBe(201);
    // The same bytes again through the same grant are a duplicate.
    expect((await s.upload(g, f)).status).toBe(409);
  });
});

describe('ADR 0958 P3 — the scan port fails closed', () => {
  it('infected and a scanner fault refuse the upload; a file stored with no scanner is scanned at accept', async () => {
    const s = await setup();
    const g = await s.grant();
    registerUploadScanner({ scan: async () => 'infected' });
    expect((await s.upload(g, [{ name: 'v.png', contentType: 'image/png', buf: pngNo(6) }])).status).toBe(422);
    registerUploadScanner({ scan: async () => { throw new Error('scanner down'); } });
    expect((await s.upload(g, [{ name: 'v.png', contentType: 'image/png', buf: pngNo(7) }])).status).toBe(503);
    expect((await s.vendor.get<{ intakes: unknown[] }>(`/host/openwop-app/collab/grants/${g.grantId}/intakes`)).body.intakes).toEqual([]);

    registerUploadScanner(null);
    const up = await s.upload(g, [{ name: 'later.png', contentType: 'image/png', buf: pngNo(8) }]);
    expect(up.status).toBe(201);
    const id = up.body.intake.intakeId;
    const detail = await s.admin.get<{ intake: { files: Array<{ scan: string }> } }>(`${s.A}/${id}`);
    expect(detail.body.intake.files[0]!.scan).toBe('not_configured');
    // A scanner configured since then is consulted at accept.
    registerUploadScanner({ scan: async () => 'infected' });
    const refused = await s.admin.post<{ details?: { reason?: string } }>(`${s.A}/${id}/accept`);
    expect(refused.status, refused.raw).toBe(409);
    expect(refused.raw).toContain('scan_infected');
    registerUploadScanner({ scan: async () => { throw new Error('down'); } });
    expect((await s.admin.post(`${s.A}/${id}/accept`)).status).toBe(503);
    // Refused accepts leave it submitted and unclaimed, so a clean scan can accept it.
    registerUploadScanner({ scan: async () => 'clean' });
    expect((await s.admin.post(`${s.A}/${id}/accept`)).status).toBe(200);
    expect(await listAssets(s.tenantId, s.orgId)).toHaveLength(1);
  });
});

describe('ADR 0958 Q2 — no scanner, no outsider uploads', () => {
  it('without the waiver: upload refused scanner_required and nothing stored; an unscanned file cannot be accepted', async () => {
    const s = await setup();
    const g = await s.grant();
    // Stored unscanned under the waiver (as a dev deployment would)...
    const up = await s.upload(g, [{ name: 'early.png', contentType: 'image/png', buf: pngNo(41) }]);
    expect(up.status).toBe(201);
    delete process.env.OPENWOP_UPLOAD_SCAN_OPTIONAL;
    try {
      const refused = await s.upload(g, [{ name: 'now.png', contentType: 'image/png', buf: pngNo(42) }]);
      expect(refused.status).toBe(503);
      expect(refused.raw).toContain('scanner_required');
      expect((await s.vendor.get<{ intakes: unknown[] }>(`/host/openwop-app/collab/grants/${g.grantId}/intakes`)).body.intakes).toHaveLength(1);
      // ...and once the waiver is gone, never accepted unscanned.
      const acc = await s.admin.post(`${s.A}/${up.body.intake.intakeId}/accept`);
      expect(acc.status).toBe(503);
      expect(acc.raw).toContain('scanner_required');
      expect(await listAssets(s.tenantId, s.orgId)).toHaveLength(0);
      // A configured scanner lifts it.
      registerUploadScanner({ scan: async () => 'clean' });
      expect((await s.upload(g, [{ name: 'now.png', contentType: 'image/png', buf: pngNo(42) }])).status).toBe(201);
    } finally {
      process.env.OPENWOP_UPLOAD_SCAN_OPTIONAL = 'true';
    }
  });
});

describe('ADR 0958 P3 — tenant and org isolation, with the uniform 404', () => {
  it('another org, another tenant, a client-org viewer and a stranger cannot read or decide the intake', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'iso.png', contentType: 'image/png', buf: pngNo(9) }]);
    const id = up.body.intake.intakeId;
    const fileId = up.body.intake.files[0]!.fileId;

    // The same agency, naming the intake under ANOTHER client: the uniform 404.
    const B = `/host/openwop-app/campaign-ops/clients/${s.otherOrgId}/intakes`;
    const missing = await s.admin.get(`${B}/does-not-exist`);
    expect(missing.status).toBe(404);
    for (const [m, p] of [['get', `${B}/${id}`], ['get', `${B}/${id}/files/${fileId}`], ['post', `${B}/${id}/accept`], ['post', `${B}/${id}/reject`]] as const) {
      const r = m === 'get' ? await s.admin.get(p) : await s.admin.post(p, { reason: 'x' });
      expect(r.status, p).toBe(404);
      expect(r.raw, `${p} must read exactly like a missing intake`).toBe(missing.raw);
    }
    expect((await s.admin.get<{ intakes: unknown[] }>(B)).body.intakes).toEqual([]);

    // Another tenant's admin naming this org and intake.
    const outsider = client();
    await outsider.post('/host/openwop-app/test/login', { email: `outsider-${n}@other.test`, tenantId: `ws:t-other-${n}` });
    for (const p of [`${s.A}/${id}`, `${s.A}/${id}/files/${fileId}`]) expect([403, 404]).toContain((await outsider.get(p)).status);
    expect([403, 404]).toContain((await outsider.post(`${s.A}/${id}/accept`)).status);

    // A client-org viewer may list but may not download or decide.
    const viewer = client();
    const vv = await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `viewer-${n}@agency.test`, tenantId: s.tenantId });
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: vv.body.user.userId, displayName: 'Viewer', roles: ['viewer'] });
    expect((await viewer.get(s.A)).status).toBe(200);
    expect([403, 404]).toContain((await viewer.get(`${s.A}/${id}/files/${fileId}`)).status);
    expect([403, 404]).toContain((await viewer.post(`${s.A}/${id}/accept`)).status);

    // A stranger naming the grant cannot upload, list or withdraw.
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${n}@elsewhere.test` });
    const V = `/host/openwop-app/collab/grants/${g.grantId}/intakes`;
    expect((await stranger.get(V)).status).toBe(404);
    expect((await stranger.post(`${V}/${id}/withdraw`)).status).toBe(404);
    expect((await stranger.post(V, { files: [], rights: RIGHTS })).status).toBe(404);

    // Still untouched.
    const still = await s.admin.get<{ intake: { status: string } }>(`${s.A}/${id}`);
    expect(still.body.intake.status).toBe('submitted');
  });

  it('a view-only grant cannot upload; another grant of the same person sees nothing; a revoked grant goes dark', async () => {
    const s = await setup();
    const viewOnly = await s.grant(['view']);
    expect((await s.upload(viewOnly, [{ name: 'v.png', contentType: 'image/png', buf: pngNo(10) }])).status).toBe(404);
    const g1 = await s.grant();
    const g2 = await s.grant();
    const up = await s.upload(g1, [{ name: 'one.png', contentType: 'image/png', buf: pngNo(11) }]);
    expect(up.status).toBe(201);
    const id = up.body.intake.intakeId;
    expect((await s.vendor.get<{ intakes: unknown[] }>(`/host/openwop-app/collab/grants/${g2.grantId}/intakes`)).body.intakes).toEqual([]);
    expect((await s.vendor.post(`/host/openwop-app/collab/grants/${g2.grantId}/intakes/${id}/withdraw`)).status).toBe(404);
    expect((await s.admin.del(`${s.C}/${s.collaborator.collaboratorId}/grants/${g1.grantId}`)).status).toBe(200);
    expect((await s.upload(g1, [{ name: 'two.png', contentType: 'image/png', buf: pngNo(12) }])).status).toBe(404);
    expect((await s.vendor.get(`/host/openwop-app/collab/grants/${g1.grantId}/intakes`)).status).toBe(404);
    // The agency can still decide what was sent before the revoke.
    expect((await s.admin.post(`${s.A}/${id}/reject`, { reason: 'Grant ended' })).status).toBe(200);
  });

  it('the external-collab toggle off darkens both sides', async () => {
    const s = await setup();
    const g = await s.grant();
    await setToggle('campaign-ops.external-collab', false);
    try {
      expect((await s.upload(g, [{ name: 't.png', contentType: 'image/png', buf: pngNo(13) }])).status).toBe(404);
      expect((await s.admin.get(s.A)).status).not.toBe(200);
    } finally {
      await setToggle('campaign-ops.external-collab', true);
    }
  });
});

describe('ADR 0958 P3 — reject, withdraw, and the 30-day purge', () => {
  it('reject keeps the bytes 30 days, then the sweep purges them; a legal hold keeps them', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'rej.png', contentType: 'image/png', buf: pngNo(14) }]);
    const id = up.body.intake.intakeId;
    const fileId = up.body.intake.files[0]!.fileId;
    expect((await s.admin.post(`${s.A}/${id}/reject`, {})).status).toBe(400); // a reason is required
    const rej = await s.admin.post<{ intake: { status: string; reason: string } }>(`${s.A}/${id}/reject`, { reason: 'Wrong bottle colour' });
    expect(rej.body.intake).toMatchObject({ status: 'rejected', reason: 'Wrong bottle colour' });
    expect((await s.admin.post(`${s.A}/${id}/accept`)).status).toBe(409);
    expect((await s.admin.get(`${s.A}/${id}/files/${fileId}`)).status).toBe(404);
    const mine = await s.vendor.get<{ intakes: Array<{ status: string; reason?: string }> }>(`/host/openwop-app/collab/grants/${g.grantId}/intakes`);
    expect(mine.body.intakes[0]).toMatchObject({ status: 'rejected', reason: 'Wrong bottle colour' });

    const DAY = 24 * 60 * 60 * 1000;
    await sweepRejectedIntakeBytes(Date.now() + 29 * DAY);
    expect(await __heldBytesExistForTests(s.tenantId, s.orgId, fileId)).toBe(true);
    await setRetentionHold(s.tenantId, 'litigation');
    try {
      await sweepRejectedIntakeBytes(Date.now() + 31 * DAY);
      expect(await __heldBytesExistForTests(s.tenantId, s.orgId, fileId)).toBe(true);
    } finally {
      await clearRetentionHold(s.tenantId);
    }
    await sweepRejectedIntakeBytes(Date.now() + 31 * DAY);
    expect(await __heldBytesExistForTests(s.tenantId, s.orgId, fileId)).toBe(false);
    // The record stays.
    const detail = await s.admin.get<{ intake: { status: string; files: Array<{ bytesPurgedAt?: string }> } }>(`${s.A}/${id}`);
    expect(detail.body.intake.status).toBe('rejected');
    expect(detail.body.intake.files[0]!.bytesPurgedAt).toBeTruthy();
  });

  it('withdraw drops the bytes at once and cannot be accepted after', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'w.png', contentType: 'image/png', buf: pngNo(15) }]);
    const id = up.body.intake.intakeId;
    const fileId = up.body.intake.files[0]!.fileId;
    const w = await s.vendor.post<{ intake: { status: string } }>(`/host/openwop-app/collab/grants/${g.grantId}/intakes/${id}/withdraw`);
    expect(w.body.intake.status).toBe('withdrawn');
    expect(await __heldBytesExistForTests(s.tenantId, s.orgId, fileId)).toBe(false);
    expect((await s.admin.post(`${s.A}/${id}/accept`)).status).toBe(409);
  });
});

describe('ADR 0958 P3 — accept is single and human', () => {
  it('two concurrent accepts make one asset', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'c.png', contentType: 'image/png', buf: pngNo(16) }]);
    const id = up.body.intake.intakeId;
    // A slow scanner holds the first accept inside its claim, so the second
    // really arrives while the first is in flight.
    registerUploadScanner({ scan: async () => { await new Promise((r) => setTimeout(r, 150)); return 'clean'; } });
    const first = s.admin.post(`${s.A}/${id}/accept`);
    await new Promise((r) => setTimeout(r, 40));
    const [a, b] = await Promise.all([first, s.admin.post<{ details?: { reason?: string } }>(`${s.A}/${id}/accept`)]);
    expect(b.raw).toContain('intake_busy');
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await listAssets(s.tenantId, s.orgId)).toHaveLength(1);
  });

  it('census: only the agency route calls acceptIntake; no pack names it', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, '..', 'src');
    const callers: string[] = [];
    const walk = (dir: string, out: string[]): void => {
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules') continue;
        const p = join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (/\.(ts|mjs|js|json)$/.test(e)) out.push(p);
      }
    };
    const files: string[] = [];
    walk(src, files);
    for (const f of files) if (/\bacceptIntake\(/.test(readFileSync(f, 'utf8'))) callers.push(f.slice(src.length + 1));
    expect(callers.sort()).toEqual(['features/campaign-ops/collaboration/intake.ts', 'features/campaign-ops/collaboration/intakeRoutes.ts']);
    const packs = join(here, '..', '..', '..', 'packs');
    const packFiles: string[] = [];
    walk(packs, packFiles);
    expect(packFiles.filter((f) => /acceptIntake|intakes\/[^"']*\/accept/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});

describe('ADR 0958 P3 — review fixes (architect pass)', () => {
  it('an accept that fails halfway leaves no library asset behind, and can be retried', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'one.png', contentType: 'image/png', buf: pngNo(20) }, { name: 'two.png', contentType: 'image/png', buf: pngNo(21) }]);
    const id = up.body.intake.intakeId;
    fault.failAfter = 1; // the first file stores, the second fails
    const broken = await s.admin.post(`${s.A}/${id}/accept`);
    expect(broken.status).toBe(500);
    expect(await listAssets(s.tenantId, s.orgId)).toEqual([]);
    const still = await s.admin.get<{ intake: { status: string; accepting: boolean } }>(`${s.A}/${id}`);
    expect(still.body.intake).toMatchObject({ status: 'submitted', accepting: false });
    // Rejecting it now leaves nothing usable either.
    expect((await s.admin.post(`${s.A}/${id}/accept`)).status).toBe(200);
    expect(await listAssets(s.tenantId, s.orgId)).toHaveLength(2);
  });

  it("the campaign's autonomy rule for accepting vendor files governs the human accept", async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'p.png', contentType: 'image/png', buf: pngNo(22) }]);
    const id = up.body.intake.intakeId;
    // The agency admin holds `owner` on the client org (not `editor`).
    const P = `/host/openwop-app/campaign-orchestration/campaigns/${s.campaign.id}/autonomy`;
    const rule = (decision: Record<string, unknown>) => ({ name: 'Vendor files', basePreset: 'guarded@1', rules: [{ actionClass: 'asset.accept-vendor', default: decision }] });
    await setToggle('campaign-orchestration.autonomy', true);
    try {
      const put = async (d: Record<string, unknown>): Promise<void> => { const r = await s.admin.put(P, rule(d)); expect(r.status, r.raw).toBe(200); };
      await put({ outcome: 'blocked', reason: 'no vendor files' });
      const blocked = await s.admin.post(`${s.A}/${id}/accept`);
      expect(blocked.status).toBe(403);
      expect(blocked.raw).toContain('autonomy_blocked');
      await put({ outcome: 'approve', approver: { roleRefs: ['editor'], requiredApprovals: 1, delegation: 'allowed' } });
      const notMe = await s.admin.post(`${s.A}/${id}/accept`);
      expect(notMe.status).toBe(403);
      expect(notMe.raw).toContain('autonomy_approver_required');
      await put({ outcome: 'approve', approver: { roleRefs: ['owner'], requiredApprovals: 2, delegation: 'allowed' } });
      const quorum = await s.admin.post(`${s.A}/${id}/accept`);
      expect(quorum.status).toBe(409);
      expect(quorum.raw).toContain('autonomy_quorum_unsupported');
      expect(await listAssets(s.tenantId, s.orgId)).toEqual([]);
      await put({ outcome: 'approve', approver: { roleRefs: ['owner'], requiredApprovals: 1, delegation: 'allowed' } });
      const ok = await s.admin.post(`${s.A}/${id}/accept`);
      expect(ok.status, ok.raw).toBe(200);
    } finally {
      await setToggle('campaign-orchestration.autonomy', false);
    }
  });

  it('after an accept that died mid-way, rejecting removes the asset it left', async () => {
    const s = await setup();
    const g = await s.grant();
    const up = await s.upload(g, [{ name: 'crash.png', contentType: 'image/png', buf: pngNo(24) }]);
    const id = up.body.intake.intakeId;
    // What a crashed accept leaves: a library asset naming this intake, the intake still submitted.
    const left = await createAsset({ tenantId: s.tenantId, orgId: s.orgId, name: 'crash.png', contentType: 'image/png', sizeBytes: 10, storageRef: 'tok-crash', serveToken: 'tok-crash', uploadedBy: 'x', suppliedBy: { kind: 'vendor', collaboratorId: s.collaborator.collaboratorId, grantId: g.grantId, intakeId: id } });
    const unrelated = await createAsset({ tenantId: s.tenantId, orgId: s.orgId, name: 'own.png', contentType: 'image/png', sizeBytes: 10, storageRef: 'tok-own', serveToken: 'tok-own', uploadedBy: 'x' });
    expect((await s.admin.post(`${s.A}/${id}/reject`, { reason: 'Not this one' })).status).toBe(200);
    expect(await getAssetByIdForTenant(s.tenantId, left.assetId)).toBeNull();
    expect(await getAssetByIdForTenant(s.tenantId, unrelated.assetId)).not.toBeNull();
  });

  it('an archived campaign takes no files', async () => {
    const s = await setup();
    const g = await s.grant();
    await updateCampaignStatus(s.tenantId, s.campaign.id, 'archived');
    expect((await s.upload(g, [{ name: 'late.png', contentType: 'image/png', buf: pngNo(23) }])).status).toBe(404);
  });
});
