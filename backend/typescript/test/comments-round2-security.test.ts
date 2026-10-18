/**
 * Feature loop round 2, row 41 (Collaboration / Comments) — the security probes.
 * Each case was written RED against `origin/main` before the fix landed.
 *
 *  S1  a `chat_message` thread hangs off a conversation, and the resolver checked the
 *      TENANT only. Any workspace member read, and wrote into, the comment threads on
 *      another person's PRIVATE conversation (the conversation itself 404s for them).
 *  S2  the owning feature's toggle was never consulted: with `cms` OFF a member still
 *      read and wrote CMS page threads (and the page title rode the notification).
 *  S3  a notification went to the resource owner / parent author without asking
 *      whether THEY can still see the resource, so a person removed from the
 *      organization was told the title of a page they can no longer open.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import type { NotificationRecord } from '../src/types.js';
import type { Comment } from '../src/features/comments/commentsService.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms', 'comments']) await setToggle(id, 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
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
/** An owner + an org + a second editor seated in that org, all in one tenant. */
async function workspaceWithEditor() {
  const owner = client();
  const tenantId = `t-cmt2-${n++}`;
  const ownerLogin = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `cmt2-owner-${n}@acme.test`, tenantId });
  expect(ownerLogin.status).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const other = client();
  const login = await other.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `cmt2-other-${n++}@acme.test`, tenantId });
  expect(login.status).toBe(201);
  const seat = await owner.post<{ memberId: string }>(`/host/openwop-app/orgs/${org.body.orgId}/members`, {
    displayName: 'Other', subject: login.body.user.userId, roles: ['editor'],
  });
  expect(seat.status, JSON.stringify(seat.body)).toBe(201);
  return {
    owner, other, tenantId, orgId: org.body.orgId,
    ownerUserId: ownerLogin.body.user.userId, otherUserId: login.body.user.userId, otherMemberId: seat.body.memberId,
    base: `/host/openwop-app/comments/orgs/${org.body.orgId}/comments`,
  };
}

describe('S1 — a chat_message thread follows the conversation’s visibility', () => {
  it('a member who cannot open a private conversation can neither read nor write its message threads', async () => {
    const { owner, other, base } = await workspaceWithEditor();
    const session = await owner.post<{ sessionId: string }>('/host/openwop-app/chat/sessions', { title: 'Salary review — private' });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    const sid = session.body.sessionId;
    // CONTROL: the conversation itself is private to its owner.
    expect((await other.get(`/host/openwop-app/chat/sessions/${sid}`)).status).toBe(404);

    const resourceId = `${sid}#m1`;
    const mine = await owner.post<Comment>(base, { resourceType: 'chat_message', resourceId, body: 'the number is 140k' });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    // CONTROL: the owner reads their own thread.
    const ownRead = await owner.get<{ comments: Comment[] }>(`${base}?resourceType=chat_message&resourceId=${encodeURIComponent(resourceId)}`);
    expect(ownRead.body.comments.map((c) => c.body)).toEqual(['the number is 140k']);

    const peek = await other.get<ErrBody>(`${base}?resourceType=chat_message&resourceId=${encodeURIComponent(resourceId)}`);
    expect(peek.status, JSON.stringify(peek.body)).toBe(404);
    const write = await other.post<ErrBody>(base, { resourceType: 'chat_message', resourceId, body: 'I was not invited' });
    expect(write.status, JSON.stringify(write.body)).toBe(404);
    // By id, too: resolve on someone else's private thread is the same 404.
    const resolve = await other.patch<ErrBody>(`${base}/${mine.body.commentId}`, { status: 'resolved' });
    expect(resolve.status).toBe(404);
  });
});

describe('S2 — the OWNING feature’s entitlement gates its resources’ threads', () => {
  // `cms` and `kb` are ALWAYS-ON (no toggle; ADR 0027), so they cannot be the
  // witness — this file's first draft used `cms`, whose `setToggle` silently did
  // nothing, and went red for an unrelated reason (the pre-code /architect pass
  // caught it). `creative-briefs` has a real toggle, default off.
  it('with `creative-briefs` OFF a brief thread is not found on read or write', async () => {
    const { owner, orgId, base, tenantId, ownerUserId } = await workspaceWithEditor();
    await setToggle('creative-briefs', 'on');
    try {
      const brief = await createBrief(tenantId, orgId, ownerUserId, { title: 'Unannounced launch', sceneDescription: 'x' });
      const read = `${base}?resourceType=creative_brief&resourceId=${encodeURIComponent(brief.briefId)}`;
      // CONTROL: with the owning feature ON the thread answers.
      expect((await owner.get(read)).status).toBe(200);
      await setToggle('creative-briefs', 'off');
      expect(getToggleDefault('creative-briefs'), 'the witness toggle must exist').toBeTruthy();
      const r = await owner.get<ErrBody>(read);
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      const w = await owner.post<ErrBody>(base, { resourceType: 'creative_brief', resourceId: brief.briefId, body: 'x' });
      expect(w.status, JSON.stringify(w.body)).toBe(404);
    } finally { await setToggle('creative-briefs', 'off'); }
  });
});

describe('S3 — a notification goes only to someone who can still see the resource', () => {
  it('a parent author removed from the organization is not told the page title', async () => {
    const { owner, other, orgId, base, ownerUserId, otherUserId, otherMemberId, tenantId } = await workspaceWithEditor();
    const page = await owner.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${orgId}/pages`, { title: 'Layoff plan Q4' });
    expect(page.status).toBe(201);
    // `getNotificationEmitter()` returns a fresh wrapper per call, so patching `emit` is
    // inert (it was, on this file's first draft: the case passed by capturing nothing).
    const emitted: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((r) => { if (r.tenantId === tenantId) emitted.push(r); });
    try {
      const root = await other.post<Comment>(base, { resourceType: 'cms_page', resourceId: page.body.pageId, body: 'a question' });
      expect(root.status).toBe(201);
      // CONTROL: the capture works — the page owner, a member, was told.
      expect(emitted.filter((e) => e.recipientUserId === ownerUserId).map((e) => e.type)).toEqual(['comment.added']);

      expect((await owner.del(`/host/openwop-app/orgs/${orgId}/members/${otherMemberId}`)).status).toBe(204);
      const reply = await owner.post<Comment>(base, { resourceType: 'cms_page', resourceId: page.body.pageId, parentId: root.body.commentId, body: 'answered' });
      expect(reply.status).toBe(201);
    } finally { unsub(); }
    const toRemoved = emitted.filter((e) => e.recipientUserId === otherUserId);
    expect(toRemoved, JSON.stringify(toRemoved)).toEqual([]);
  });
});
