/**
 * ADR 0953 P0 — the social post store and routes.
 *
 * Setup is a real shared `ws:` workspace with two client orgs. EDITOR holds
 * `editor` on client A; VIEWER holds `viewer` on client A; OUTSIDER holds
 * `editor` on client B only.
 *
 * Pins (the P0 exit criteria):
 *  - cross-org reads and writes are a uniform 404, never a 403 that says the post exists;
 *  - a viewer reads but cannot draft, edit or schedule (403);
 *  - an edit to what would be posted voids the approval and returns the post to
 *    draft; a schedule-only edit keeps it;
 *  - a stale editor (`expectedVersion`) is a 409; of two concurrent edits, one that
 *    loses the race is a 409 too, so neither is silently overwritten;
 *  - text over the platform's limit, a non-http link, a past or >366-day schedule
 *    are refused; a published post cannot be edited or deleted;
 *  - erasure keeps the post and tombstones the people in it.
 *
 * Sabotage-witnessed (8f W6), each red: keep the approval on a content edit; void
 * it on a schedule-only edit; drop the expectedVersion compare; ignore a lost CAS
 * on edit; let a viewer write; answer 403 to the outsider; count UTF-16 units
 * instead of characters; accept a non-http link or a secret-shaped run; delete a
 * published post; stop retrying a lost erasure CAS; report a stuck erasure as done;
 * leave the approver's id in place.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSocialPublishingSubject } from '../src/features/social-publishing/erasure.js';
import { getPost, updatePost } from '../src/features/social-publishing/postService.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import type { SocialPost } from '../src/features/social-publishing/types.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let TENANT = '';
let orgA = '';
let orgB = '';
let editor = ''; let viewer = ''; let outsider = '';
let editorId = '';

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = { post: SocialPost }>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app/social/orgs${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown; try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
/** The post store itself, for the states only a later phase can reach (an approval, a publish). */
const postStore = () => new DurableCollection<SocialPost>('social:post', (x) => `${x.tenantId}::${x.orgId}::${x.postId}`, undefined, (x) => x.tenantId);
const draft = (over: Record<string, unknown> = {}) => ({ platform: 'linkedin', accountRef: 'urn:li:organization:42', text: 'Our Q4 webinar is live.', link: 'https://example.test/webinar', ...over });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-channels', 'social-publishing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:sp-owner' });
  TENANT = ws.tenantId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  const mk = async (principal: string, org: string, role: string, home: string): Promise<{ id: string; cookie: string }> => {
    const u = await upsertFromPrincipal({ tenantId: TENANT, principalId: principal, source: 'oidc' });
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u.userId, displayName: principal, roles: ['viewer'] });
    await createMember({ tenantId: TENANT, orgId: org, subject: u.userId, displayName: principal, roles: [role] });
    return { id: u.userId, cookie: cookieFor(u.userId, home) };
  };
  const e = await mk('oidc:sp-editor', orgA, 'editor', 'ws:home-e'); editor = e.cookie; editorId = e.id;
  viewer = (await mk('oidc:sp-viewer', orgA, 'viewer', 'ws:home-v')).cookie;
  outsider = (await mk('oidc:sp-outsider', orgB, 'editor', 'ws:home-o')).cookie;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0953 P0 — routes and RBAC', () => {
  it('an editor drafts; a viewer reads but cannot write or schedule; an outsider gets a uniform 404', async () => {
    const c = await call(editor, 'POST', `/${orgA}/posts`, draft());
    expect(c.status, c.raw).toBe(201);
    const p = c.body.post;
    expect(p).toMatchObject({ orgId: orgA, status: 'draft', version: 1, platform: 'linkedin', aiDisclosure: { aiGenerated: false } });
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await call(viewer, 'GET', `/${orgA}/posts/${p.postId}`)).status).toBe(200);
    expect((await call<{ posts: SocialPost[] }>(viewer, 'GET', `/${orgA}/posts`)).body.posts.map((x) => x.postId)).toContain(p.postId);
    expect((await call(viewer, 'POST', `/${orgA}/posts`, draft())).status).toBe(403);
    expect((await call(viewer, 'PATCH', `/${orgA}/posts/${p.postId}`, { scheduledFor: inHours(2) })).status).toBe(403);
    expect((await call(viewer, 'POST', `/${orgA}/posts/${p.postId}/cancel`)).status).toBe(403);

    // The outsider edits client B; client A's posts do not exist for them.
    for (const [m, path, body] of [['GET', `/${orgA}/posts/${p.postId}`], ['GET', `/${orgA}/posts`], ['PATCH', `/${orgA}/posts/${p.postId}`, { text: 'x' }], ['DELETE', `/${orgA}/posts/${p.postId}`], ['POST', `/${orgA}/posts`, draft()]] as const) {
      const r = await call(outsider, m, path, body);
      expect(r.status, `${m} ${path}: ${r.raw}`).toBe(404);
    }
    // A real post id under the WRONG org is also a 404 for its own editor.
    expect((await call(outsider, 'GET', `/${orgB}/posts/${p.postId}`)).status).toBe(404);
  });

  it('the toggle off is a 404 naming the feature, for reads and writes alike', async () => {
    const d = getToggleDefault('social-publishing')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      for (const [m, body] of [['GET'], ['POST', draft()]] as const) {
        const r = await call(editor, m, `/${orgA}/posts`, body);
        expect(r.status, `${m}: ${r.raw}`).toBe(404);
        expect(r.raw).toContain('social-publishing');
      }
    } finally { await saveConfig({ ...d, status: 'on' }, 'test'); }
    expect((await call(editor, 'GET', `/${orgA}/posts`)).status).toBe(200);
  });
});

describe('ADR 0953 P0 — the post state machine', () => {
  it('a content edit voids the approval and returns to draft; a schedule-only edit keeps it', async () => {
    const p = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    // Stand in for P2's gate: give the post an approval bound to its hash.
    const store = postStore();
    const approved: SocialPost = { ...p, status: 'scheduled', approval: { approvalId: 'appr-1', contentHash: p.contentHash }, scheduledFor: inHours(5), version: p.version + 1 };
    expect(await store.compareAndSwap(p, approved)).toBe(true);

    const moved = await call(editor, 'PATCH', `/${orgA}/posts/${p.postId}`, { scheduledFor: inHours(9), expectedVersion: approved.version });
    expect(moved.status, moved.raw).toBe(200);
    expect(moved.body.post).toMatchObject({ status: 'scheduled', approval: { approvalId: 'appr-1' }, contentHash: p.contentHash });

    const edited = await call(editor, 'PATCH', `/${orgA}/posts/${p.postId}`, { text: 'Our Q4 webinar is live. Register now.' });
    expect(edited.body.post.status).toBe('draft');
    expect(edited.body.post.approval).toBeUndefined();
    expect(edited.body.post.contentHash).not.toBe(p.contentHash);

    // Media and account changes count as content too.
    const again = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    const h0 = again.contentHash;
    const m = (await call(editor, 'PATCH', `/${orgA}/posts/${again.postId}`, { media: [{ mediaAssetId: 'asset-1', kind: 'image' }] })).body.post;
    const a = (await call(editor, 'PATCH', `/${orgA}/posts/${again.postId}`, { accountRef: 'urn:li:organization:43' })).body.post;
    expect(new Set([h0, m.contentHash, a.contentHash]).size).toBe(3);
  });

  it('a stale editor is a 409, and two concurrent edits never both land', async () => {
    const p = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    const ok = await call(editor, 'PATCH', `/${orgA}/posts/${p.postId}`, { text: 'one', expectedVersion: 1 });
    expect(ok.status).toBe(200);
    const stale = await call(editor, 'PATCH', `/${orgA}/posts/${p.postId}`, { text: 'two', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.raw).toContain('post_changed');
    const [r1, r2] = await Promise.allSettled([
      updatePost(TENANT, orgA, p.postId, { text: 'three' }),
      updatePost(TENANT, orgA, p.postId, { text: 'four' }),
    ]);
    // Each edit that lands bumps the version once, and one that loses the race is a
    // 409 `post_changed`, never a silent overwrite.
    const landed = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    for (const r of [r1, r2]) if (r.status === 'rejected') expect(r.reason).toMatchObject({ details: { reason: 'post_changed' } });
    const final = await getPost(TENANT, orgA, p.postId);
    expect(landed).toBeGreaterThanOrEqual(1);
    expect(final?.version).toBe(2 + landed);
    expect(['three', 'four']).toContain(final?.text);
  });

  it('refuses what a platform would refuse, and keeps published posts', async () => {
    const bad = async (body: Record<string, unknown>, field: string): Promise<void> => {
      const r = await call(editor, 'POST', `/${orgA}/posts`, draft(body));
      expect(r.status, r.raw).toBe(400);
      expect(r.raw).toContain(field);
    };
    await bad({ platform: 'myspace' }, 'platform');
    await bad({ platform: 'x', text: 'Join us. '.repeat(32) }, 'text'); // 288 characters
    await bad({ link: 'javascript:alert(1)' }, 'link');
    await bad({ scheduledFor: new Date(Date.now() - 60_000).toISOString() }, 'scheduledFor');
    await bad({ scheduledFor: new Date(Date.now() + 367 * 86_400_000).toISOString() }, 'scheduledFor');
    await bad({ media: [{ mediaAssetId: 'a', kind: 'gif' }] }, 'media');
    // A secret-shaped run is refused, never silently redacted into the published text.
    await bad({ text: `Use code ${'A1b2C3d4E5'.repeat(5)} today` }, 'looks like a key');
    await bad({ accountRef: '' }, 'accountRef');
    // 280 emoji are 560 UTF-16 units and still 280 characters to X.
    expect((await call(editor, 'POST', `/${orgA}/posts`, draft({ platform: 'x', text: '\u{1F680}'.repeat(280) }))).status).toBe(201);

    const p = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    const store = postStore();
    const published: SocialPost = { ...p, status: 'published', platformPostId: 'li-1', version: p.version + 1 };
    expect(await store.compareAndSwap(p, published)).toBe(true);
    expect((await call(editor, 'PATCH', `/${orgA}/posts/${p.postId}`, { text: 'x' })).status).toBe(409);
    expect((await call(editor, 'POST', `/${orgA}/posts/${p.postId}/cancel`)).status).toBe(409);
    expect((await call(editor, 'DELETE', `/${orgA}/posts/${p.postId}`)).status).toBe(409);

    const d = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    expect((await call(editor, 'POST', `/${orgA}/posts/${d.postId}/cancel`)).body.post.status).toBe('canceled');
    expect((await call(editor, 'DELETE', `/${orgA}/posts/${d.postId}`)).status).toBe(204);
    expect((await call(editor, 'GET', `/${orgA}/posts/${d.postId}`)).status).toBe(404);
  });
});

describe('ADR 0953 P0 — erasure', () => {
  it('retries a lost erasure CAS without losing a concurrent schedule edit', async () => {
    const p = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    const store = postStore();
    expect(await store.compareAndSwap(p, { ...p, approval: { approvalId: 'race', contentHash: p.contentHash, decidedBy: editorId }, version: p.version + 1 })).toBe(true);
    const scheduledFor = inHours(8);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let edited = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!edited && args[0].includes(p.postId)) {
        edited = true;
        await updatePost(TENANT, orgA, p.postId, { scheduledFor });
      }
      return cas(...args);
    });
    try {
      expect((await eraseSocialPublishingSubject(TENANT, editorId)).rowsTouched).toBeGreaterThanOrEqual(1);
    } finally { spy.mockRestore(); }
    expect(edited).toBe(true);
    expect(await getPost(TENANT, orgA, p.postId)).toMatchObject({
      createdBy: ERASED_USER_REF, approval: { decidedBy: ERASED_USER_REF }, scheduledFor, text: p.text,
    });
  });

  it('reports incomplete erasure when every CAS loses', async () => {
    const p = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    const cas = storage.kvCompareAndSwap.bind(storage);
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) =>
      args[0].includes(p.postId) ? { swapped: false, actual: args[1] } : cas(...args));
    try {
      await expect(eraseSocialPublishingSubject(TENANT, editorId))
        .rejects.toMatchObject({ details: { reason: 'subject_erasure_conflict' } });
    } finally { spy.mockRestore(); }
    expect((await getPost(TENANT, orgA, p.postId))?.createdBy).toBe(editorId);
    await eraseSocialPublishingSubject(TENANT, editorId);
    expect((await getPost(TENANT, orgA, p.postId))?.createdBy).toBe(ERASED_USER_REF);
  });

  it('keeps the post and tombstones its creator and approver', async () => {
    const p = (await call(editor, 'POST', `/${orgA}/posts`, draft())).body.post;
    const store = postStore();
    expect(await store.compareAndSwap(p, { ...p, approval: { approvalId: 'a', contentHash: p.contentHash, decidedBy: editorId }, version: p.version + 1 })).toBe(true);
    const r = await eraseSocialPublishingSubject(TENANT, editorId);
    expect(r.rowsTouched).toBeGreaterThanOrEqual(1);
    const after = await getPost(TENANT, orgA, p.postId);
    expect(after).not.toBeNull();
    expect(after?.createdBy).toBe(ERASED_USER_REF);
    expect(after?.approval?.decidedBy).toBe(ERASED_USER_REF);
    expect(after?.text).toBe(p.text);
    // Another tenant is never touched.
    expect((await eraseSocialPublishingSubject('ws:other', editorId)).rowsTouched).toBe(0);
  });
});
