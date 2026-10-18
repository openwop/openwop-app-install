/**
 * ADR 0881 — comments round 2: the upgrades (the security probes are in
 * `comments-round2-security.test.ts`). Through the real HTTP door unless a case says
 * otherwise:
 *
 *  D2  every owning feature a target declares is a REAL toggle (cms/kb are always-on,
 *      so they declare `null` — a typo here would 404 a whole type on every lane).
 *  D4  a reply notifies everyone already in the thread, one notification per person.
 *  D5  mentions: member-only (400 otherwise, nothing written); a member who cannot
 *      open the target is not stored, not told, and named back to the author.
 *  D6  resolvedBy / resolvedAt / editedAt; a re-resolve is a no-op.
 *  D7  the thread read carries `viewer`.
 *  D8  host events for an org-visible target, none for a restricted one.
 *  D9  model-facing prose names every resource type (generated or pinned).
 *  D10 erasure strips a subject from other rows' mentions.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as Array<{ type: string; tenantId: string; payload: Record<string, unknown> }>);
vi.mock('../src/host/hostEventDispatcher.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/hostEventDispatcher.js')>()),
  emitHostEvent: async (e: { type: string; tenantId: string; payload: Record<string, unknown> }) => { events.push(e); },
}));

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import type { NotificationRecord } from '../src/types.js';
import { RESOURCE_TYPES, __targetFeatureIds, deleteSubjectComments, getComment, type Comment } from '../src/features/comments/commentsService.js';
import { registerCommentsAgentTools, COMMENTS_LIST_TOOL_ID, COMMENTS_POST_TOOL_ID } from '../src/features/comments/agentTools.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'comments']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
type Posted = Comment & { unnotifiedMentions: string[] };
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: (p: string) => call<undefined>('DELETE', p),
  };
}

let n = 0;
/** An owner + org + page, and `k` editors seated in the org, all in one tenant. */
async function workspace(k: number) {
  const owner = client();
  const tenantId = `t-cmt881-${n++}`;
  const ol = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `o-${n}@acme.test`, tenantId });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  const page = await owner.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${org.body.orgId}/pages`, { title: 'Roadmap' });
  expect(page.status).toBe(201);
  const editors: Array<{ c: ReturnType<typeof client>; userId: string }> = [];
  for (let i = 0; i < k; i++) {
    const c = client();
    const l = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `e${i}-${n++}@acme.test`, tenantId });
    const seat = await owner.post(`/host/openwop-app/orgs/${org.body.orgId}/members`, { displayName: `Ed ${i}`, subject: l.body.user.userId, roles: ['editor'] });
    expect(seat.status).toBe(201);
    editors.push({ c, userId: l.body.user.userId });
  }
  return { owner, ownerUserId: ol.body.user.userId, tenantId, orgId: org.body.orgId, pageId: page.body.pageId, editors, base: `/host/openwop-app/comments/orgs/${org.body.orgId}/comments` };
}

async function capture<T>(tenantId: string, fn: () => Promise<T>): Promise<{ out: T; got: NotificationRecord[] }> {
  const got: NotificationRecord[] = [];
  const unsub = getNotificationEmitter().subscribe((r) => { if (r.tenantId === tenantId) got.push(r); });
  try { return { out: await fn(), got }; } finally { unsub(); }
}

describe('D2 — owning-feature declarations are real toggles', () => {
  it('every non-null featureId is a registered toggle; cms and kb (always-on) declare null', () => {
    const ids = __targetFeatureIds();
    expect(ids.cms_page).toBeNull();
    expect(ids.kb_collection).toBeNull();
    expect(ids.chat_message).toBeNull();
    for (const [type, id] of Object.entries(ids)) {
      if (id !== null) expect(getToggleDefault(id), `${type} → ${id} is not a toggle`).toBeTruthy();
    }
  });
});

describe('D4 — a reply notifies the whole thread', () => {
  it('root author and an earlier replier both hear a later reply; the replier is not told twice', async () => {
    const { owner, ownerUserId, tenantId, pageId, editors: [a, b], base } = await workspace(2);
    const root = await a!.c.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'root' });
    await b!.c.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, parentId: root.body.commentId, body: 'first reply' });
    const { got } = await capture(tenantId, () => owner.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, parentId: root.body.commentId, body: 'owner reply' }));
    const to = got.map((g) => `${g.recipientUserId}:${g.type}`).sort();
    expect(to).toEqual([`${a!.userId}:comment.reply`, `${b!.userId}:comment.reply`].sort());
    expect(got.some((g) => g.recipientUserId === ownerUserId)).toBe(false); // never the actor
  });
});

describe('D5 — mentions', () => {
  it('a non-member id is refused with 400 and nothing is written', async () => {
    const { owner, pageId, base } = await workspace(0);
    const r = await owner.post<ErrBody>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'hi', mentions: ['user:not-a-member'] });
    expect(r.status).toBe(400);
    expect(r.body.details?.field).toBe('mentions');
    const thread = await owner.get<{ comments: Comment[] }>(`${base}?resourceType=cms_page&resourceId=${pageId}`);
    expect(thread.body.comments).toEqual([]);
  });

  it('a mentioned member is told once (mention outranks reply) and stored on the row', async () => {
    const { owner, tenantId, pageId, editors: [a], base } = await workspace(1);
    const root = await a!.c.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'q' });
    const { out, got } = await capture(tenantId, () => owner.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, parentId: root.body.commentId, body: 'see this', mentions: [a!.userId] }));
    expect(out.status).toBe(201);
    expect(out.body.mentions).toEqual([a!.userId]);
    expect(out.body.unnotifiedMentions).toEqual([]);
    expect(got.map((g) => `${g.recipientUserId}:${g.type}`)).toEqual([`${a!.userId}:comment.mention`]);
  });

  it('a member who cannot open the target is not stored, not told, and named back to the author', async () => {
    const { owner, tenantId, editors: [a], base } = await workspace(1);
    const s = await owner.post<{ sessionId: string }>('/host/openwop-app/chat/sessions', { title: 'private' });
    const { out, got } = await capture(tenantId, () => owner.post<Posted>(base, { resourceType: 'chat_message', resourceId: `${s.body.sessionId}#m1`, body: 'psst', mentions: [a!.userId] }));
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body.mentions).toBeUndefined();
    expect(out.body.unnotifiedMentions).toEqual([a!.userId]);
    expect(got).toEqual([]);
  });
});

describe('D6/D7 — resolution + edit metadata, viewer capabilities', () => {
  it('resolve stamps who/when and tells the author; reopen clears; a re-resolve is a no-op', async () => {
    const { owner, ownerUserId, tenantId, pageId, editors: [a], base } = await workspace(1);
    const c = await a!.c.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'fix the typo' });
    const { out, got } = await capture(tenantId, () => owner.patch<Comment>(`${base}/${c.body.commentId}`, { status: 'resolved' }));
    expect(out.body.resolvedBy).toBe(ownerUserId);
    expect(typeof out.body.resolvedAt).toBe('string');
    expect(got.map((g) => `${g.recipientUserId}:${g.type}`)).toEqual([`${a!.userId}:comment.resolved`]);
    const again = await capture(tenantId, () => owner.patch<Comment>(`${base}/${c.body.commentId}`, { status: 'resolved' }));
    expect(again.out.body.resolvedAt).toBe(out.body.resolvedAt);
    expect(again.got).toEqual([]);
    const reopened = await owner.patch<Comment>(`${base}/${c.body.commentId}`, { status: 'open' });
    expect(reopened.body.resolvedBy).toBeUndefined();
    expect(reopened.body.resolvedAt).toBeUndefined();
  });

  it('a body edit stamps editedAt; the thread read carries viewer capabilities', async () => {
    const { owner, ownerUserId, pageId, editors: [a], base } = await workspace(1);
    const c = await a!.c.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'v1' });
    expect(c.body.editedAt).toBeUndefined();
    const e = await a!.c.patch<Comment>(`${base}/${c.body.commentId}`, { body: 'v2' });
    expect(typeof e.body.editedAt).toBe('string');
    const asOwner = await owner.get<{ viewer: { userId: string; canWrite: boolean; canModerate: boolean } }>(`${base}?resourceType=cms_page&resourceId=${pageId}`);
    expect(asOwner.body.viewer).toEqual({ userId: ownerUserId, canWrite: true, canModerate: true });
    const asEditor = await a!.c.get<{ viewer: { canWrite: boolean; canModerate: boolean } }>(`${base}?resourceType=cms_page&resourceId=${pageId}`);
    expect(asEditor.body.viewer.canWrite).toBe(true);
    expect(asEditor.body.viewer.canModerate).toBe(false);
  });
});

describe('D8 — host events', () => {
  it('created + resolved for an org-visible target; nothing for a private conversation', async () => {
    const { owner, tenantId, pageId, base } = await workspace(0);
    events.length = 0;
    const c = await owner.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'x' });
    await owner.patch(`${base}/${c.body.commentId}`, { status: 'resolved' });
    const mine = events.filter((e) => e.tenantId === tenantId);
    expect(mine.map((e) => e.type)).toEqual(['host.comments.comment.created', 'host.comments.comment.resolved']);
    expect(mine[0]!.payload).toEqual({ orgId: c.body.orgId, resourceType: 'cms_page', resourceId: pageId, commentId: c.body.commentId });

    events.length = 0;
    const s = await owner.post<{ sessionId: string }>('/host/openwop-app/chat/sessions', { title: 'private' });
    const p = await owner.post<Posted>(base, { resourceType: 'chat_message', resourceId: `${s.body.sessionId}#m1`, body: 'x' });
    expect(p.status).toBe(201);
    await owner.patch(`${base}/${p.body.commentId}`, { status: 'resolved' });
    expect(events.filter((e) => e.tenantId === tenantId)).toEqual([]);
  });
});

describe('D9 — model-facing prose names every resource type', () => {
  it('both tool descriptions and the reviewer prompt enumerate RESOURCE_TYPES', () => {
    registerCommentsAgentTools();
    const tools = [builtinAgentTool(COMMENTS_LIST_TOOL_ID), builtinAgentTool(COMMENTS_POST_TOOL_ID)].filter((t) => t !== undefined);
    expect(tools).toHaveLength(2);
    const prompt = readFileSync(join(__dirname, '../../../packs/vendor.openwop-app.comments.agents/prompts/comments-reviewer.md'), 'utf8');
    for (const type of RESOURCE_TYPES) {
      expect(prompt, `prompt omits ${type}`).toContain(type);
      for (const t of tools) expect(t.def.description, `${t.def.name} omits ${type}`).toContain(type);
    }
  });
});

describe('D10 — erasure reaches mentions', () => {
  it('erasing a mentioned person strips them from someone else’s comment, which stays', async () => {
    const { owner, tenantId, orgId, pageId, editors: [a], base } = await workspace(1);
    const c = await owner.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'ping', mentions: [a!.userId] });
    expect(c.body.mentions).toEqual([a!.userId]);
    await deleteSubjectComments(tenantId, a!.userId);
    const after = await getComment(tenantId, orgId, c.body.commentId, { preAuthorized: true });
    expect(after?.body).toBe('ping');
    expect(after?.mentions).toBeUndefined();
  });
});

describe('CM2CD-6 — the witnesses /grade-code found missing', () => {
  it('an edit that adds a mention notifies only the newly mentioned person', async () => {
    const { owner, tenantId, pageId, editors: [a, b], base } = await workspace(2);
    const c = await owner.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'v1', mentions: [a!.userId] });
    const { out, got } = await capture(tenantId, () => owner.patch<Posted>(`${base}/${c.body.commentId}`, { body: 'v2', mentions: [a!.userId, b!.userId] }));
    expect(out.status).toBe(200);
    expect(out.body.mentions).toEqual([a!.userId, b!.userId]);
    expect(got.map((g) => `${g.recipientUserId}:${g.type}`)).toEqual([`${b!.userId}:comment.mention`]);
  });

  it('erasing the person who resolved a comment clears resolvedBy; the comment stays', async () => {
    const { owner, tenantId, orgId, pageId, editors: [a], base } = await workspace(1);
    const c = await owner.post<Posted>(base, { resourceType: 'cms_page', resourceId: pageId, body: 'keep me' });
    await a!.c.patch(`${base}/${c.body.commentId}`, { status: 'resolved' });
    await deleteSubjectComments(tenantId, a!.userId);
    const after = await getComment(tenantId, orgId, c.body.commentId, { preAuthorized: true });
    expect(after?.body).toBe('keep me');
    expect(after?.status).toBe('resolved');
    expect(after?.resolvedBy).toBeUndefined();
  });

  it('an archived channel’s message threads refuse new comments AND edits (409), and stay readable', async () => {
    const { owner, base } = await workspace(0);
    const ch = await owner.post<{ channel: { channelId?: string; conversationId?: string; sessionId?: string } }>('/host/openwop-app/channels', { name: `arch-${n++}`, visibility: 'public' });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    const id = ch.body.channel.channelId ?? ch.body.channel.conversationId ?? ch.body.channel.sessionId;
    const resourceId = `${id}#m1`;
    const c = await owner.post<Posted>(base, { resourceType: 'chat_message', resourceId, body: 'before' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await owner.post(`/host/openwop-app/channels/${id}/archive`)).status).toBe(204);
    const add = await owner.post<ErrBody>(base, { resourceType: 'chat_message', resourceId, body: 'after' });
    expect(add.status).toBe(409);
    const edit = await owner.patch<ErrBody>(`${base}/${c.body.commentId}`, { body: 'edited after' });
    expect(edit.status).toBe(409);
    const read = await owner.get<{ comments: Comment[] }>(`${base}?resourceType=chat_message&resourceId=${encodeURIComponent(resourceId)}`);
    expect(read.body.comments.map((x) => x.body)).toEqual(['before']);
  });
});
