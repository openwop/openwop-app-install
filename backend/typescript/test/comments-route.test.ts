/**
 * Collaboration / Comments (ADR 0021) — ROUTE + service harness. Boots the real app
 * and drives: threaded comment CRUD (RBAC, cross-org IDOR, unknown resourceType,
 * toggle-off 404), the string notification emit (tenant-scoped, comment.added /
 * comment.reply), the ctx.features.comments surface + node-pack smoke, and the
 * well-known advertisement. Proves the Comments↔CMS↔Notifications composition.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, __resetCms } from '../src/features/cms/cmsService.js';
import { createComment, deleteComment, listThread, __resetCommentsStore } from '../src/features/comments/commentsService.js';
import { emitCommentNotification } from '../src/features/comments/notifications.js';
import { buildCommentsSurface } from '../src/features/comments/surface.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import type { NotificationRecord } from '../src/types.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

/** ADR 0659 D1 — `listThread` now answers `null` when the target is absent OR invisible.
 *  Every fixture here creates a real resource and is not testing that gate, so a null is
 *  a genuine failure rather than an expected branch. */
async function listThreadOrFail(...args: Parameters<typeof listThread>): Promise<NonNullable<Awaited<ReturnType<typeof listThread>>>> {
  const rows = await listThread(...args);
  if (rows === null) throw new Error('listThread resolved no target — the fixture did not create it');
  return rows;
}

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms', 'comments']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const pub = client();
let n = 0;
/** An owner in a deterministic tenant, with an org + a CMS page to comment on. */
async function ownerWithPage(): Promise<{ owner: ReturnType<typeof client>; orgId: string; pageId: string; tenantId: string }> {
  const owner = client();
  const tenantId = `t-cmt-${n++}`;
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: `cmt-${n}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const page = await owner.post(`/v1/host/openwop-app/cms/orgs/${org.body.orgId}/pages`, { title: 'Home' });
  expect(page.status, JSON.stringify(page.body)).toBe(201);
  return { owner, orgId: org.body.orgId, pageId: page.body.pageId, tenantId };
}
const enableComments = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('comments'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Comments: thread CRUD (RBAC) + IDOR + validation', () => {
  it('is registered + advertises ctx.features.comments', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'comments')).toBe(true);
    expect((await pub.get('/.well-known/openwop')).body.hostExtensions?.featureSurfaces).toContain('host.sample.comments');
  });

  it('owner posts a comment + reply, lists the thread, resolves, deletes', async () => {
    const { owner, orgId, pageId } = await ownerWithPage();
    const base = `/v1/host/openwop-app/comments/orgs/${orgId}/comments`;
    const c1 = await owner.post(base, { resourceType: 'cms_page', resourceId: pageId, body: 'First note' });
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    expect(c1.body.status).toBe('open');
    const r1 = await owner.post(base, { resourceType: 'cms_page', resourceId: pageId, parentId: c1.body.commentId, body: 'A reply' });
    expect(r1.status).toBe(201);
    expect(r1.body.parentId).toBe(c1.body.commentId);

    const thread = await owner.get(`${base}?resourceType=cms_page&resourceId=${pageId}`);
    expect(thread.body.comments).toHaveLength(2);

    const resolved = await owner.patch(`${base}/${c1.body.commentId}`, { status: 'resolved' });
    expect(resolved.body.status).toBe('resolved');

    expect((await owner.del(`${base}/${c1.body.commentId}`)).status).toBe(204);
    // deleting a root cascades to its reply → thread empty
    expect((await owner.get(`${base}?resourceType=cms_page&resourceId=${pageId}`)).body.comments).toHaveLength(0);
  });

  it('unknown resourceType 400s; unknown resourceId 404s', async () => {
    const { owner, orgId, pageId } = await ownerWithPage();
    const base = `/v1/host/openwop-app/comments/orgs/${orgId}/comments`;
    expect((await owner.post(base, { resourceType: 'nope', resourceId: pageId, body: 'x' })).status).toBe(400);
    expect((await owner.post(base, { resourceType: 'cms_page', resourceId: 'pg:ghost', body: 'x' })).status).toBe(404);
  });

  it('cross-tenant access 404s (IDOR)', async () => {
    const a = await ownerWithPage();
    const b = await ownerWithPage();
    // b cannot read a's org thread (org not in b's tenant)
    expect((await b.owner.get(`/v1/host/openwop-app/comments/orgs/${a.orgId}/comments?resourceType=cms_page&resourceId=${a.pageId}`)).status).toBe(404);
  });

  /**
   * ADR 0659 D6 — this case is named for the author guard and, until 2026-09-11, asserted
   * the OWNER editing their OWN body. Its comment deferred to "the service test below",
   * which does not exist, so `commentsService.updateComment`'s author guard had ZERO
   * behavioural coverage — and that is how the prior pass counted it as covered. The name
   * now matches what it does, and the guard has a real witness beneath it.
   */
  it('the author CAN edit their own body', async () => {
    const { owner, orgId, pageId } = await ownerWithPage();
    const base = `/v1/host/openwop-app/comments/orgs/${orgId}/comments`;
    const c = await owner.post(base, { resourceType: 'cms_page', resourceId: pageId, body: 'mine' });
    const edited = await owner.patch(`${base}/${c.body.commentId}`, { body: 'mine (edited)' });
    expect(edited.body.body).toBe('mine (edited)');
  });

  it('a non-author member CANNOT edit another author’s body (403), but CAN resolve it', async () => {
    const { owner, orgId, pageId, tenantId } = await ownerWithPage();
    const base = `/v1/host/openwop-app/comments/orgs/${orgId}/comments`;
    const c = await owner.post(base, { resourceType: 'cms_page', resourceId: pageId, body: 'mine' });

    // A SECOND principal in the same tenant, seated in the org with write.
    const other = client();
    const login = await other.post('/v1/host/openwop-app/test/login', { email: `cmt-other-${n++}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const seat = await owner.post(`/v1/host/openwop-app/orgs/${orgId}/members`, {
      displayName: 'Other', subject: login.body.user.userId, roles: ['editor'],
    });
    expect(seat.status, JSON.stringify(seat.body)).toBe(201);

    // Body edit: refused, and the row is untouched.
    const refused = await other.patch(`${base}/${c.body.commentId}`, { body: 'not mine to edit' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden_scope');
    const still = await other.get(`${base}?resourceType=cms_page&resourceId=${pageId}`);
    expect(still.body.comments[0].body).toBe('mine');

    // Resolve is member-level by design — the guard is author-only for the BODY.
    const resolved = await other.patch(`${base}/${c.body.commentId}`, { status: 'resolved' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('resolved');
  });

  it('toggle OFF ⇒ 404 (backend authority)', async () => {
    const { owner, orgId, pageId } = await ownerWithPage();
    const base = `/v1/host/openwop-app/comments/orgs/${orgId}/comments`;
    try {
      await enableComments('off');
      expect((await owner.get(`${base}?resourceType=cms_page&resourceId=${pageId}`)).status).toBe(404);
      expect((await owner.post(base, { resourceType: 'cms_page', resourceId: pageId, body: 'x' })).status).toBe(404);
    } finally { await enableComments('on'); }
  });
});

describe('Comments: notification emit (string types, tenant-scoped)', () => {
  beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });

  it('emits comment.added to the resource owner + comment.reply to the parent author', async () => {
    const captured: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((r) => captured.push(r));
    try {
      const page = await createPage({ tenantId: 'tN', orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
      // a reviewer (not the owner) comments → comment.added to owner1
      const a = await createComment({ tenantId: 'tN', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'looks off', authorId: 'reviewer' , caller: { subject: 'reviewer' }});
      await emitCommentNotification(a.comment, a.notify);
      // owner1 replies to the reviewer → comment.reply to reviewer
      const b = await createComment({ tenantId: 'tN', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, parentId: a.comment.commentId, body: 'fixed', authorId: 'owner1' , caller: { subject: 'owner1' }});
      await emitCommentNotification(b.comment, b.notify);

      const types = captured.filter((r) => r.tenantId === 'tN').map((r) => r.type);
      expect(types).toContain('comment.added');
      expect(types).toContain('comment.reply');
      // no core-union edit: types are plain namespaced strings
      const added = captured.find((r) => r.type === 'comment.added');
      expect(added?.metadata?.recipientId).toBe('owner1');
      expect(added?.actionUrl).toContain('/comments?');
      // C11 — ADDRESSED per-recipient, never broadcast tenant-wide: comment.added
      // goes to the resource owner, comment.reply to the parent author.
      expect(added?.recipientUserId).toBe('owner1');
      const reply = captured.find((r) => r.type === 'comment.reply');
      expect(reply?.recipientUserId).toBe('reviewer');
    } finally { unsub(); }
  });

  it('self-activity (owner comments on own resource) emits nothing', async () => {
    const captured: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((r) => { if (r.tenantId === 'tSelf') captured.push(r); });
    try {
      const page = await createPage({ tenantId: 'tSelf', orgId: 'o1', title: 'Doc', createdBy: 'solo' });
      const s = await createComment({ tenantId: 'tSelf', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'note to self', authorId: 'solo' , caller: { subject: 'solo' }});
      await emitCommentNotification(s.comment, s.notify);
      expect(captured).toHaveLength(0);
    } finally { unsub(); }
  });
});

describe('Comments: delete-cascade authorization (no data-loss by a non-admin)', () => {
  beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });

  it('a non-admin author cannot delete a root that others replied under (409); admin can', async () => {
    const page = await createPage({ tenantId: 'tD', orgId: 'o1', title: 'Doc', createdBy: 'A' });
    const root = await createComment({ tenantId: 'tD', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'root by A', authorId: 'A' , caller: { subject: 'A' }});
    await createComment({ tenantId: 'tD', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, parentId: root.comment.commentId, body: 'reply by B', authorId: 'B' , caller: { subject: 'B' }});
    // A (author, non-admin) is blocked — B's reply must not be destroyed.
    await expect(deleteComment('tD', 'o1', root.comment.commentId, { userId: 'A', isAdmin: false }, PREAUTHORIZED_CALLER)).rejects.toThrow(/replies from other people/);
    expect((await listThreadOrFail('tD', 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER)).length).toBe(2);
    // An org admin may delete the root — cascade removes the thread.
    expect(await deleteComment('tD', 'o1', root.comment.commentId, { userId: 'admin', isAdmin: true }, PREAUTHORIZED_CALLER)).toBe(true);
    expect((await listThreadOrFail('tD', 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER)).length).toBe(0);
  });

  it('a non-admin author CAN delete their own root when only their own replies hang off it', async () => {
    const page = await createPage({ tenantId: 'tD2', orgId: 'o1', title: 'Doc', createdBy: 'A' });
    const root = await createComment({ tenantId: 'tD2', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'root by A', authorId: 'A' , caller: { subject: 'A' }});
    await createComment({ tenantId: 'tD2', orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, parentId: root.comment.commentId, body: 'self reply', authorId: 'A' , caller: { subject: 'A' }});
    expect(await deleteComment('tD2', 'o1', root.comment.commentId, { userId: 'A', isAdmin: false }, PREAUTHORIZED_CALLER)).toBe(true);
    expect((await listThreadOrFail('tD2', 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER)).length).toBe(0);
  });
});

describe('Comments: ctx.features.comments + nodes', () => {
  beforeEach(async () => { await __resetCommentsStore(); await __resetCms(); });

  it('surface post/list/resolve + node post run', async () => {
    // CMNT-4 — the surface now enforces the same org-membership predicate the
    // routes and chat tools do, so the run must carry an acting user who is a
    // member of a real org in this tenant.
    const { createOrg } = await import('../src/host/accessControlService.js');
    await createOrg({ tenantId: 'tS', createdBy: 'owner1', name: 'Acme', orgId: 'o1', ownerSubject: 'owner1' });
    const page = await createPage({ tenantId: 'tS', orgId: 'o1', title: 'Doc', createdBy: 'owner1' });
    const surf = buildCommentsSurface({ tenantId: 'tS', runId: 'run-1', actingUserId: 'owner1' });
    const posted = (await surf.post({ orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'agent note' })) as { comment: Record<string, unknown> | null };
    expect(posted.comment).toBeTruthy();
    expect(posted.comment?.authorId).toBe('agent:run-1'); // agent-authored provenance
    expect(posted.comment?.tenantId).toBeUndefined();      // internal projected out

    const listed = (await surf.list({ orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId })) as { comments: unknown[] };
    expect(listed.comments).toHaveLength(1);

    const mod = await import('../../../packs/feature.comments.nodes/index.mjs');
    const ctx = (i: Record<string, unknown>) => ({ features: { comments: surf }, inputs: i });
    const r = await mod.nodes['feature.comments.nodes.post'](ctx({ orgId: 'o1', resourceType: 'cms_page', resourceId: page.pageId, body: 'via node' }));
    expect(r.status).toBe('success');
    expect((await listThreadOrFail('tS', 'o1', 'cms_page', page.pageId, PREAUTHORIZED_CALLER)).length).toBe(2);
  });
});

describe('Comments: chat_message commentable type (ADR 0021 extension)', () => {
  it('comments on a chat message in the caller tenant; unknown session / cross-tenant 404s', async () => {
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const owner = client();
    const tenantId = `t-chat-${n++}`;
    expect((await owner.post('/v1/host/openwop-app/test/login', { email: `chat-${n}@acme.test`, tenantId })).status).toBe(201);
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId as string;

    // Seed a chat session in the caller's tenant.
    const sessionId = `sess-${n}`;
    const now = new Date().toISOString();
    await hostExtStorage().createChatSession({ sessionId, tenantId, title: 'My Chat', createdAt: now, updatedAt: now, messageCount: 0 });

    const base = `/v1/host/openwop-app/comments/orgs/${orgId}/comments`;
    const rid = `${sessionId}#msg-42`;

    const c = await owner.post(base, { resourceType: 'chat_message', resourceId: rid, body: 'Nice answer 👍' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.resourceType).toBe('chat_message');

    const thread = await owner.get(`${base}?resourceType=chat_message&resourceId=${encodeURIComponent(rid)}`);
    expect(thread.status).toBe(200);
    expect(thread.body.comments.length).toBe(1);
    expect(thread.body.comments[0].body).toBe('Nice answer 👍');

    // Unknown session id → 404 (no cross-tenant existence leak).
    const missing = await owner.post(base, { resourceType: 'chat_message', resourceId: 'nope#m1', body: 'x' });
    expect(missing.status).toBe(404);

    // A different tenant's user cannot see or comment on this session (IDOR).
    const other = client();
    await other.post('/v1/host/openwop-app/test/login', { email: `other-${n}@x.test`, tenantId: `t-other-${n}` });
    const otherOrg = await other.post('/v1/host/openwop-app/orgs', { name: 'Other' });
    const otherBase = `/v1/host/openwop-app/comments/orgs/${otherOrg.body.orgId}/comments`;
    const leak = await other.post(otherBase, { resourceType: 'chat_message', resourceId: rid, body: 'peek' });
    expect(leak.status).toBe(404);
  });
});
