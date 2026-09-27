/**
 * Creative Briefs (ADR 0353) — ROUTE-level harness: toggle gating, lifecycle
 * CRUD + transitions (privileged approval), versions + field diffs, the three
 * build modes, mood-board assembly over media selection, PDF export bytes,
 * approved-only sharing, and cross-tenant IDOR (uniform 404).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

/** ADR 0659 D1 — the route can no longer surface a dead target's rows, so the cascade is
 *  asserted at the store instead. Same collection + key shape as `commentsService`. */
const commentRows = new DurableCollection<{ commentId: string; tenantId: string; resourceId: string }>(
  'comments:thread', (c) => c.commentId, undefined, (c) => c.tenantId,
);

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'creative-briefs', 'media', 'sharing', 'comments']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any; raw?: Response }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    if (res.headers.get('content-type')?.includes('application/pdf')) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), raw: res };
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

const CB = (orgId: string, s = ''): string => `/v1/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}${s}`;
const M = (orgId: string, s = ''): string => `/v1/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${s}`;
const SHARE = (orgId: string): string => `/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`;
const COMMENTS = (orgId: string, s = ''): string => `/v1/host/openwop-app/comments/orgs/${encodeURIComponent(orgId)}/comments${s}`;

// A valid 1x1 PNG (the media upload seed).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function ownerWithOrg() {
  const c = client();
  const tenantId = `org:cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId as string, tenantId };
}

describe('creative-briefs lifecycle', () => {
  it('creates, edits (version bump + approved-demotion), transitions, diffs, exports PDF', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(CB(orgId, '/briefs'), {
      title: 'Hero shot', assetType: 'image', sceneDescription: 'Robot picking produce in a bright warehouse.',
      directions: [{ label: 'Product in use', rationale: 'Outcome-first' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.briefId;
    expect(created.body.status).toBe('draft');
    expect(created.body.version).toBe(1);

    // review → approved (owner has host:members:manage) → content edit demotes.
    expect((await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'review' })).body.status).toBe('review');
    expect((await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' })).body.status).toBe('approved');
    const edited = await c.patch(CB(orgId, `/briefs/${id}`), { sceneDescription: 'Night shift — cool blue lighting.' });
    expect(edited.body.status).toBe('draft'); // approval demotion
    expect(edited.body.version).toBe(2);

    // invalid transition draft → approved is a 409.
    expect((await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' })).status).toBe(409);

    const diff = await c.get(CB(orgId, `/briefs/${id}/diff?from=1&to=2`));
    expect(diff.status).toBe(200);
    expect(diff.body.changes.map((ch: { field: string }) => ch.field)).toContain('sceneDescription');

    const pdf = await c.post(CB(orgId, `/briefs/${id}/pdf`), {});
    expect(pdf.status).toBe(200);
    expect(Buffer.isBuffer(pdf.body)).toBe(true);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('build modes: extraction projects a kernel; merge overlays a base', async () => {
    const { c, orgId } = await ownerWithOrg();
    const ext = await c.post(CB(orgId, '/briefs'), {
      mode: 'extraction',
      kernel: { headline: 'Pick 40% faster', supportingStatement: 'Robots do the walking', primaryCta: 'Book a demo' },
      platform: 'linkedin',
    });
    expect(ext.status, JSON.stringify(ext.body)).toBe(201);
    expect(ext.body.title).toContain('Pick 40% faster');
    expect(ext.body.platformSpec).toMatchObject({ platform: 'linkedin' });
    expect(ext.body.directions.length).toBeGreaterThan(0);

    const merged = await c.post(CB(orgId, '/briefs'), {
      mode: 'merge',
      base: { title: 'Base title', sceneDescription: 'Base scene', assetType: 'video' },
      sceneDescription: 'Overlaid scene',
    });
    expect(merged.status).toBe(201);
    expect(merged.body.title).toBe('Base title');
    expect(merged.body.sceneDescription).toBe('Overlaid scene');
    expect(merged.body.assetType).toBe('video');
  });

  it('sharing is approved-only; cross-tenant reads are uniform 404', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(CB(orgId, '/briefs'), { title: 'Sharable', sceneDescription: 'S' });
    const id = created.body.briefId;

    // Draft brief refuses to mint a share link (409 from the resolver).
    const mintDraft = await c.post(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'creative_brief', resourceId: id });
    expect([400, 409]).toContain(mintDraft.status);

    await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'review' });
    await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' });
    const mint = await c.post(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'creative_brief', resourceId: id });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);

    // Stranger tenant: uniform 404.
    const stranger = client();
    await stranger.post('/v1/host/openwop-app/test/login', { email: `x-${Date.now()}@t.test`, tenantId: `org:x-${Date.now()}` });
    expect((await stranger.get(CB(orgId, `/briefs/${id}`))).status).toBe(404);
  });

  it('mood board assembles from the media library + stamps the needsAsset gap', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(CB(orgId, '/briefs'), { title: 'MB', sceneDescription: 'S' });

    // EMPTY library → the "go shoot this" gap lands on the brief (needsAsset
    // now means "no images at all" — MEDIA-CODE-6 terminal fallback).
    const noAssets = await c.post(CB(orgId, `/briefs/${created.body.briefId}/moodboard`), { product: 'Nonexistent' });
    expect(noAssets.body.moodBoard).toEqual([]);
    expect(noAssets.body.needsAssetNote).toContain('Nonexistent');

    // Seed a facet-tagged image → assembly matches + clears the gap note.
    await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'fp.png', marketing: { product: 'FlashPick' } });
    const withBoard = await c.post(CB(orgId, `/briefs/${created.body.briefId}/moodboard`), { product: 'FlashPick' });
    expect(withBoard.status).toBe(200);
    expect(withBoard.body.moodBoard.length).toBeGreaterThan(0);
    expect(withBoard.body.needsAssetNote).toBeUndefined();

    // Unmatchable criteria with a non-empty library → the terminal criteria-free
    // fallback proposes SOMETHING (no gap note).
    const fallback = await c.post(CB(orgId, `/briefs/${created.body.briefId}/moodboard`), { product: 'Nonexistent' });
    expect(fallback.body.moodBoard.length).toBeGreaterThan(0);
    expect(fallback.body.needsAssetNote).toBeUndefined();
  });

  it('mood-board assembly demotes an APPROVED brief + purges its share links, like PATCH (CB-CODE-1)', async () => {
    const { c, orgId } = await ownerWithOrg();
    await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'fp.png', marketing: { product: 'FlashPick' } });
    const created = await c.post(CB(orgId, '/briefs'), { title: 'Demote me', sceneDescription: 'S' });
    const id = created.body.briefId;
    await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'review' });
    expect((await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' })).body.status).toBe('approved');

    const mint = await c.post(SHARE(orgId), { resourceType: 'creative_brief', resourceId: id });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token as string;
    expect((await c.get(`/v1/host/openwop-app/shared/${token}`)).status).toBe(200); // live before

    const after = await c.post(CB(orgId, `/briefs/${id}/moodboard`), { product: 'FlashPick' });
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('draft'); // demoted — no silent mutation of an approved brief
    expect((await c.get(`/v1/host/openwop-app/shared/${token}`)).status).toBe(404); // link purged
  });

  it('deleting a brief clears its media usage-refs and prunes its comments (CB-CODE-2 / CS-DATA-2/14)', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg();
    const up = await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'used.png' });
    expect(up.status).toBe(201);
    const created = await c.post(CB(orgId, '/briefs'), {
      title: 'Doomed', sceneDescription: 'S', moodBoard: [{ mediaAssetId: up.body.assetId }],
    });
    const id = created.body.briefId;

    // The create stamped a creative-brief usage-ref on the asset.
    const usage = await c.get(M(orgId, `/assets/${up.body.assetId}/usage`));
    expect(usage.status).toBe(200);
    expect(usage.body.usage.map((u: { refId: string }) => u.refId)).toContain(id);

    // A review comment on the brief.
    const comment = await c.post(COMMENTS(orgId), { resourceType: 'creative_brief', resourceId: id, body: 'tighten the crop' });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    // Delete → the usage-ref AND the comment thread cascade.
    expect((await c.del(CB(orgId, `/briefs/${id}`))).status).toBe(204);
    const usageAfter = await c.get(M(orgId, `/assets/${up.body.assetId}/usage`));
    expect(usageAfter.body.usage).toEqual([]);
    // ADR 0659 D1/D2 — a thread whose TARGET is gone is a uniform 404, not `200 {comments:[]}`.
    // The old assertion pinned the defect this ADR closed: a 200-with-empty read is exactly
    // what let the panel render "be the first to leave a note" on a deleted resource, with a
    // live composer whose post then 404'd. The prune itself is asserted at the store below,
    // because once the target is gone the route can no longer show you the rows either way.
    const threads = await c.get(COMMENTS(orgId, `?resourceType=creative_brief&resourceId=${encodeURIComponent(id)}`));
    expect(threads.status).toBe(404);
    const remaining = (await commentRows.listForTenantIndexed(tenantId)).filter((r) => r.resourceId === id);
    expect(remaining, 'the cascade pruned the rows, not merely hid them').toEqual([]);
  });

  it('the public share renders mood-board asset NAMES only — no raw ids, no internal notes (CB-CODE-6)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(CB(orgId, '/briefs'), { title: 'Public brief', sceneDescription: 'S' });
    const id = created.body.briefId;
    // Land a needsAssetNote while the library is empty.
    const gap = await c.post(CB(orgId, `/briefs/${id}/moodboard`), { product: 'Ghost' });
    expect(gap.body.needsAssetNote).toBeTruthy();
    // Then a board with one resolvable asset and one DEAD id.
    const up = await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'Warehouse hero.png' });
    await c.patch(CB(orgId, `/briefs/${id}`), {
      moodBoard: [{ mediaAssetId: up.body.assetId, note: 'matched: product' }, { mediaAssetId: 'masset:00000000-dead' }],
    });
    await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'review' });
    await c.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' });
    const mint = await c.post(SHARE(orgId), { resourceType: 'creative_brief', resourceId: id });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);

    const shared = await c.get(`/v1/host/openwop-app/shared/${mint.body.token}`);
    expect(shared.status).toBe(200);
    const md = shared.body.resource.markdown as string;
    expect(md).toContain('Warehouse hero.png'); // resolvable asset renders by NAME
    expect(md).not.toContain('masset:'); // raw/dead asset ids never print
    expect(md).not.toContain('plan a shoot'); // internal needsAssetNote omitted
    expect(md).not.toContain('matched: product'); // internal selection notes omitted

    // The authed PDF path (internal audience) still exports.
    const pdf = await c.post(CB(orgId, `/briefs/${id}/pdf`), {});
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('concurrent updates never lose a write — CAS retries then 409s (CB-CODE-3)', async () => {
    const { createBrief, updateBrief, getBrief } = await import('../src/features/creative-briefs/creativeBriefsService.js');
    const tenantId = `t-cas-${Date.now()}`;
    const orgId = 'org-cas';
    const b = await createBrief(tenantId, orgId, 'u0', { title: 'CAS', sceneDescription: 'base' });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => updateBrief(tenantId, orgId, b.briefId, `u${i}`, { sceneDescription: `edit ${i}` })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'conflict', httpStatus: 409 });
    }
    expect(ok).toBeGreaterThan(0);
    // Every committed write bumped the version exactly once — none clobbered.
    const final = await getBrief(tenantId, orgId, b.briefId);
    expect(final!.version).toBe(1 + ok);
  });

  it('R2 CRB-SP-2: a transition racing a concurrent edit never erases the edit or regresses version', async () => {
    const { createBrief, updateBrief, transitionBrief, getBrief } = await import('../src/features/creative-briefs/creativeBriefsService.js');
    const tenantId = `t-tcas-${Date.now()}`;
    const orgId = 'org-tcas';
    const b = await createBrief(tenantId, orgId, 'u0', { title: 'TCAS', sceneDescription: 'base' });

    // The old transition was read-then-put: interleaved with an edit it put the
    // STALE row back — losing the edit, approving content the approver never
    // saw, and regressing version (which corrupts render briefVersion
    // semantics). Race them; both must land (CAS retries), whatever the order.
    const results = await Promise.allSettled([
      updateBrief(tenantId, orgId, b.briefId, 'editor', { sceneDescription: 'edited during review' }),
      transitionBrief(tenantId, orgId, b.briefId, 'reviewer', 'review'),
    ]);
    for (const r of results) expect(r.status, JSON.stringify(r)).toBe('fulfilled');
    const final = await getBrief(tenantId, orgId, b.briefId);
    expect(final!.sceneDescription).toBe('edited during review'); // the edit survived
    expect(final!.status).toBe('review'); // the transition survived
    expect(final!.version).toBe(2); // bumped by the edit, never regressed
  });

  it('R2 CRB-SP-7: platformSpec set → clear round-trips — null is the explicit clear, absent means keep', async () => {
    const { createBrief, updateBrief, getBrief } = await import('../src/features/creative-briefs/creativeBriefsService.js');
    const tenantId = `t-ps-${Date.now()}`;
    const b = await createBrief(tenantId, 'org-ps', 'u0', { title: 'PS', sceneDescription: 'scene' });
    await updateBrief(tenantId, 'org-ps', b.briefId, 'u1', { platformSpec: { platform: 'meta' } });
    expect((await getBrief(tenantId, 'org-ps', b.briefId))!.platformSpec).toEqual({ platform: 'meta' });
    // Absent key: KEEP (an unrelated save must not wipe the spec).
    await updateBrief(tenantId, 'org-ps', b.briefId, 'u1', { title: 'PS renamed' });
    expect((await getBrief(tenantId, 'org-ps', b.briefId))!.platformSpec).toEqual({ platform: 'meta' });
    // Explicit null: CLEAR. Before this, no payload shape could clear it — a
    // cleaned-to-empty spec was omitted from the patch, the spread resurrected
    // the stored value, and the editor's Save button re-armed forever.
    await updateBrief(tenantId, 'org-ps', b.briefId, 'u1', { platformSpec: null });
    expect((await getBrief(tenantId, 'org-ps', b.briefId))!.platformSpec).toBeUndefined();
  });

  it('R2 CRB-SP-10: a PATCH cannot blank the required sceneDescription (symmetric with create)', async () => {
    const { createBrief, updateBrief } = await import('../src/features/creative-briefs/creativeBriefsService.js');
    const tenantId = `t-sym-${Date.now()}`;
    const b = await createBrief(tenantId, 'org-sym', 'u0', { title: 'Sym', sceneDescription: 'must stay' });
    await expect(updateBrief(tenantId, 'org-sym', b.briefId, 'u1', { sceneDescription: '' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    // (The review→approved error-severity gate added alongside is defense for
    // LEGACY rows — with symmetric validation, an error-severity brief is no
    // longer constructible through any write path.)
  });
});
