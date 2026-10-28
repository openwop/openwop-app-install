/**
 * ADR 0947 P0 — proofing annotations ride the ONE comments store.
 *
 *   - `media_asset` is a commentable target: same org reads and writes; another
 *     org's asset is the uniform 404;
 *   - a root comment may carry a version-stamped `anchor`, an `intent` and a
 *     `visibility`; the anchor is checked closed-world against the subject at its
 *     CURRENT version (out-of-range geometry, a stale version, a timecode on an
 *     image, an unknown page section, an unknown key, an anchor on a type that
 *     takes none, an anchor on a reply) → 400 and nothing stored;
 *   - `host:comments:write` (a delegable host scope, not RFC 0049 wire): a custom
 *     role holding `workspace:read` + `host:comments:write` can annotate and
 *     resolve but cannot edit the workspace (a CMS page write is refused); a
 *     plain viewer can do neither; a custom role may carry the new scope but
 *     still not a management scope; `workspace:write` implies it, never the
 *     reverse; the thread reports `canWrite` from the comment scope;
 *   - only a person on the HTTP lane may mark a comment `shared`; the chat tool
 *     and the workflow surface cannot (Q2).
 *
 * Sabotage notes (2026-10-20): drop the `unionScopes` implication → red (an
 * editor-only custom role loses commenting); let a reply carry an anchor → red;
 * skip `checkAnchor` → red (stale version and out-of-range stored); route POST
 * back on `workspace:write` → red (the reviewer is refused); let `mayShare`
 * default true → red (the surface shares).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createAsset, deleteAsset } from '../src/features/media/mediaService.js';
import { createMember, resolveEffectiveAccess, createCustomRole } from '../src/host/accessControlService.js';
import { buildCommentsSurface } from '../src/features/comments/surface.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { createComment, __commentsForTenant, type Comment } from '../src/features/comments/commentsService.js';

const listThreadRaw = async (tenantId: string, assetId: string) => (await __commentsForTenant(tenantId)).filter((c) => c.resourceType === 'media_asset' && c.resourceId === assetId);

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms', 'comments']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  };
}

let n = 0;
const HASH = 'a'.repeat(64);

async function workspace() {
  const tenantId = `t-proof-${n++}`;
  const owner = client();
  const oLogin = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `proof-owner-${n}@acme.test`, tenantId });
  expect(oLogin.status).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Client A' });
  const orgB = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Client B' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const base = { tenantId, sizeBytes: 10, storageRef: 'mem://x', serveToken: 'tok', uploadedBy: 'seed' };
  const image = await createAsset({ ...base, orgId, name: 'Hero shot.png', contentType: 'image/png', contentHash: HASH });
  const video = await createAsset({ ...base, orgId, name: 'Launch cut.mp4', contentType: 'video/mp4' });
  const other = await createAsset({ ...base, orgId: orgB.body.orgId, name: 'Other client.png', contentType: 'image/png', contentHash: HASH });
  const page = await createPage({ tenantId, orgId, title: 'Landing', createdBy: 'seed', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  // A reviewer: a custom role with read + comment-write, no workspace edit rights.
  const role = await owner.post<{ role?: { roleId: string }; roleId?: string }>(`/host/openwop-app/orgs/${orgId}/roles`, {
    name: 'Reviewer', scopes: ['workspace:read', 'host:comments:write', 'approvals:respond'],
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const roleId = role.body.role?.roleId ?? role.body.roleId ?? '';
  const reviewer = client();
  const rLogin = await reviewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `proof-reviewer-${n}@acme.test`, tenantId });
  await createMember({ tenantId, orgId, subject: rLogin.body.user.userId, displayName: 'Reviewer', roles: [roleId] });
  const viewer = client();
  const vLogin = await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `proof-viewer-${n}@acme.test`, tenantId });
  await createMember({ tenantId, orgId, subject: vLogin.body.user.userId, displayName: 'Viewer', roles: ['viewer'] });
  const C = `/host/openwop-app/comments/orgs/${orgId}/comments`;
  return { tenantId, orgId, orgB: orgB.body.orgId, owner, ownerId: oLogin.body.user.userId, reviewer, viewer, reviewerId: rLogin.body.user.userId, image, video, other, page, C };
}

describe('ADR 0947 D2 — media_asset targets', () => {
  it('same-org reads and writes; another org\'s asset is the uniform 404', async () => {
    const w = await workspace();
    const c = await w.owner.post<Comment>(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Crop tighter.' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const thread = await w.owner.get<{ comments: Comment[] }>(`${w.C}?resourceType=media_asset&resourceId=${w.image.assetId}`);
    expect(thread.body.comments.map((x) => x.body)).toEqual(['Crop tighter.']);
    const cross = await w.owner.post<ErrBody>(w.C, { resourceType: 'media_asset', resourceId: w.other.assetId, body: 'x' });
    expect(cross.status).toBe(404);
    expect((await w.owner.get(`${w.C}?resourceType=media_asset&resourceId=${w.other.assetId}`)).status).toBe(404);
  });
});

describe('ADR 0947 D2 — lifecycle', () => {
  it('deleting a media asset prunes its threads', async () => {
    const w = await workspace();
    expect((await w.owner.post(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Pin.', anchor: { subjectVersion: HASH, target: { kind: 'point', x: 0.5, y: 0.5 } } })).status).toBe(201);
    expect(await deleteAsset(w.tenantId, w.orgId, w.image.assetId)).toBe(true);
    const rows = await listThreadRaw(w.tenantId, w.image.assetId);
    expect(rows).toEqual([]);
  });
});

describe('ADR 0947 D2 — anchors, intent, visibility', () => {
  it('stores a valid region pin with intent and visibility on the current version', async () => {
    const w = await workspace();
    const c = await w.owner.post<Comment>(w.C, {
      resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Logo too small here.',
      anchor: { subjectVersion: HASH, target: { kind: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.1 } },
      intent: 'change-request', visibility: 'shared',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ anchor: { subjectVersion: HASH, target: { kind: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }, intent: 'change-request', visibility: 'shared' });
  });

  it('a legacy asset without a content hash is versioned by its id; a video takes timecodes', async () => {
    const w = await workspace();
    const ok = await w.owner.post<Comment>(w.C, {
      resourceType: 'media_asset', resourceId: w.video.assetId, body: 'Cut this beat.',
      anchor: { subjectVersion: `legacy:${w.video.assetId}`, target: { kind: 'timecode', startMs: 1200, endMs: 3400, region: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it.each([
    ['out-of-range geometry', { subjectVersion: HASH, target: { kind: 'region', x: 0.8, y: 0, w: 0.5, h: 0.1 } }, 'out_of_range'],
    ['a stale version', { subjectVersion: 'b'.repeat(64), target: { kind: 'point', x: 0.5, y: 0.5 } }, 'stale_subject_version'],
    ['a timecode on an image', { subjectVersion: HASH, target: { kind: 'timecode', startMs: 0 } }, 'kind_not_allowed'],
    ['an unknown key', { subjectVersion: HASH, target: { kind: 'point', x: 0.5, y: 0.5, z: 1 } }, 'unknown_property'],
    ['an unknown kind', { subjectVersion: HASH, target: { kind: 'circle' } }, 'unknown_kind'],
  ])('refuses %s with 400 and stores nothing', async (_name, anchor, reason) => {
    const w = await workspace();
    const r = await w.owner.post<ErrBody>(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, body: 'x', anchor });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.details?.reason).toBe(reason);
    expect((await w.owner.get<{ comments: Comment[] }>(`${w.C}?resourceType=media_asset&resourceId=${w.image.assetId}`)).body.comments).toEqual([]);
  });

  it('a page takes element pins on a section of its current version only', async () => {
    const w = await workspace();
    const sectionId = w.page.sections[0]?.sectionId ?? '';
    const ok = await w.owner.post<Comment>(w.C, { resourceType: 'cms_page', resourceId: w.page.pageId, body: 'Headline.', anchor: { subjectVersion: String(w.page.version), target: { kind: 'element', sectionId, field: 'heading' } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const ghost = await w.owner.post<ErrBody>(w.C, { resourceType: 'cms_page', resourceId: w.page.pageId, body: 'x', anchor: { subjectVersion: String(w.page.version), target: { kind: 'element', sectionId: 'sec_ghost' } } });
    expect(ghost.body.details?.reason).toBe('unknown_section');
    const region = await w.owner.post<ErrBody>(w.C, { resourceType: 'cms_page', resourceId: w.page.pageId, body: 'x', anchor: { subjectVersion: String(w.page.version), target: { kind: 'point', x: 0.1, y: 0.1 } } });
    expect(region.body.details?.reason).toBe('kind_not_allowed');
  });

  it('a type that takes no anchor, and a reply, refuse one', async () => {
    const w = await workspace();
    const root = await w.owner.post<Comment>(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Root.' });
    const reply = await w.owner.post<ErrBody>(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, parentId: root.body.commentId, body: 'Reply.', anchor: { subjectVersion: HASH, target: { kind: 'point', x: 0.1, y: 0.1 } } });
    expect(reply.body.details?.reason).toBe('reply_not_anchorable');
    const replyIntent = await w.owner.post<ErrBody>(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, parentId: root.body.commentId, body: 'Reply.', intent: 'change-request' });
    expect(replyIntent.status).toBe(400);
  });

  it('only a person may share: a write without `mayShare` (the tool and surface lanes) is refused (Q2)', async () => {
    const w = await workspace();
    const caller = { subject: w.reviewerId, principal: w.reviewerId, toggle: { userId: w.reviewerId } };
    await expect(createComment({ tenantId: w.tenantId, orgId: w.orgId, resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Agent note.', authorId: 'agent:run-1', onBehalfOf: w.reviewerId, caller, visibility: 'shared' }))
      .rejects.toMatchObject({ details: { reason: 'share_not_allowed' } });
    // The surface lane never offers `visibility`, so what it writes is internal.
    const surface = buildCommentsSurface({ tenantId: w.tenantId, actingUserId: w.reviewerId });
    await expect(surface.post({ orgId: w.orgId, resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Agent note.' })).resolves.toBeTruthy();
    const thread = await w.owner.get<{ comments: Comment[] }>(`${w.C}?resourceType=media_asset&resourceId=${w.image.assetId}`);
    expect(thread.body.comments.map((c) => c.visibility)).toEqual([undefined]);
  });
});

describe('ADR 0947 D2 — host:comments:write', () => {
  it('a reviewer can annotate and resolve, but cannot edit the workspace', async () => {
    const w = await workspace();
    const c = await w.reviewer.post<Comment>(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, body: 'Needs the real bottle.', intent: 'change-request' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await w.reviewer.patch<Comment>(`${w.C}/${c.body.commentId}`, { status: 'resolved' })).status).toBe(200);
    const thread = await w.reviewer.get<{ viewer: { canWrite: boolean } }>(`${w.C}?resourceType=media_asset&resourceId=${w.image.assetId}`);
    expect(thread.body.viewer.canWrite).toBe(true);
    const edit = await w.reviewer.post(`/host/openwop-app/cms/orgs/${w.orgId}/pages`, { title: 'Sneaky' });
    expect([403, 404]).toContain(edit.status);
  });

  it('a viewer can read but neither annotate nor edit', async () => {
    const w = await workspace();
    expect((await w.viewer.post(w.C, { resourceType: 'media_asset', resourceId: w.image.assetId, body: 'x' })).status).toBe(403);
    const thread = await w.viewer.get<{ viewer: { canWrite: boolean } }>(`${w.C}?resourceType=media_asset&resourceId=${w.image.assetId}`);
    expect(thread.status).toBe(200);
    expect(thread.body.viewer.canWrite).toBe(false);
  });

  it('workspace:write implies the comment scope, never the reverse', async () => {
    const w = await workspace();
    const writer = await createCustomRole({ tenantId: w.tenantId, orgId: w.orgId, name: 'Old editor', scopes: ['workspace:read', 'workspace:write'] });
    const reviewer = await createCustomRole({ tenantId: w.tenantId, orgId: w.orgId, name: 'Reviewer 2', scopes: ['workspace:read', 'host:comments:write'] });
    await createMember({ tenantId: w.tenantId, orgId: w.orgId, subject: 'u-old-editor', displayName: 'Old', roles: [writer.roleId] });
    await createMember({ tenantId: w.tenantId, orgId: w.orgId, subject: 'u-reviewer-2', displayName: 'R2', roles: [reviewer.roleId] });
    expect((await resolveEffectiveAccess(w.tenantId, { subject: 'u-old-editor', orgId: w.orgId })).scopes).toContain('host:comments:write');
    expect((await resolveEffectiveAccess(w.tenantId, { subject: 'u-reviewer-2', orgId: w.orgId })).scopes).not.toContain('workspace:write');
  });

  it('a developer key that declared workspace:write keeps commenting; one that declared only read does not', async () => {
    // Through the resolver every route uses: a key acts as `apikey:<keyId>`, narrowed
    // to the scopes it declared (ADR 0795), and the implication applies to the
    // declaration exactly as it applies to a role.
    const w = await workspace();
    const scopesOf = async (scopes: string[]) => {
      const { key } = await issueApiKey({ tenantId: w.tenantId, name: scopes.join('+'), createdBy: w.ownerId, scopes });
      return (await resolveEffectiveAccess(w.tenantId, { subject: `apikey:${key.keyId}`, orgId: w.orgId })).scopes;
    };
    expect(await scopesOf(['workspace:read', 'workspace:write'])).toContain('host:comments:write');
    expect(await scopesOf(['workspace:read'])).not.toContain('host:comments:write');
    const commenter = await scopesOf(['workspace:read', 'host:comments:write']);
    expect(commenter).toContain('host:comments:write');
    expect(commenter).not.toContain('workspace:write');
  });

  it('a custom role may carry the delegable scope, never a management scope', async () => {
    const w = await workspace();
    const bad = await w.owner.post<ErrBody>(`/host/openwop-app/orgs/${w.orgId}/roles`, { name: 'Sneaky', scopes: ['host:members:manage'] });
    expect(bad.status).toBe(400);
  });
});
