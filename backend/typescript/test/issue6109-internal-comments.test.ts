/**
 * Issue 6109 — a comment thread's `visibility: 'internal'` (ADR 0947 D2) is kept on
 * read, not only stored.
 *
 * The one reader every door calls (`listThread`, and `getComment` by id) shows
 * `internal` threads only to a caller that says it is a member (`audience:
 * 'member'`). Every caller today establishes org membership at its door and says
 * so; any other caller, absent included, gets the client's view: shared threads,
 * their replies, and nothing else, so neither an internal body nor the number of
 * internal comments reaches it. A by-id read of an internal comment is the same
 * null as a missing row.
 *
 * Witnesses:
 * - over the route, a member reads both threads (no change for today's readers);
 * - a non-member caller (the shape a client portal or the ADR 1099 collaborator
 *   lane will pass) reads the shared thread only, replies included, with the
 *   internal count gone; by id, an internal root and an internal reply are null;
 * - every file that marks a caller `'member'` is pinned, so a new door that does
 *   so is a reviewed change;
 * - subject erasure and resource pruning still remove internal comments: they
 *   read the store directly, never through the filtered reader.
 *
 * Sabotage notes: `visibleToAudience` returning true for every caller reds the
 * non-member cases; dropping the root lookup for replies reds the reply case;
 * a new `audience: 'member'` site reds the pin.
 */
import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __commentsForTenant, deleteSubjectComments, getComment, listThread, pruneThreadsForResourceAndComposites, type Comment } from '../src/features/comments/commentsService.js';

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
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = (await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
/** A page with one internal thread (root + reply) and one shared thread (root + reply). */
async function threads() {
  const owner = client();
  const tenantId = `t-6109-${n++}`;
  const l = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `o-6109-${n}@firm.test`, tenantId });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Firm' });
  const page = await owner.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${org.body.orgId}/pages`, { title: 'Kitchen plan' });
  expect(page.status).toBe(201);
  const base = `/host/openwop-app/comments/orgs/${org.body.orgId}/comments`;
  const target = { resourceType: 'cms_page', resourceId: page.body.pageId };
  const post = async (body: Record<string, unknown>): Promise<Comment> => {
    const r = await owner.post<Comment>(base, { ...target, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const internal = await post({ body: 'Margin on the cabinets is thin; do not tell the client.' });
  const internalReply = await post({ body: 'Agreed, keep it quiet.', parentId: internal.commentId });
  const shared = await post({ body: 'Please confirm the oak finish.', visibility: 'shared' });
  const sharedReply = await post({ body: 'Oak confirmed.', parentId: shared.commentId });
  return { owner, tenantId, orgId: org.body.orgId, userId: l.body.user.userId, base, target, internal, internalReply, shared, sharedReply };
}

describe('issue 6109 — internal threads stay internal on read', () => {
  it('a member reads both threads over the route (no change for today\'s readers)', async () => {
    const t = await threads();
    const r = await t.owner.get<{ comments: Comment[] }>(`${t.base}?resourceType=cms_page&resourceId=${t.target.resourceId}`);
    expect(r.status).toBe(200);
    expect(r.body.comments.map((c) => c.commentId).sort()).toEqual([t.internal, t.internalReply, t.shared, t.sharedReply].map((c) => c.commentId).sort());
  });

  it('a non-member caller gets the shared thread only: no internal bodies, no internal count', async () => {
    const t = await threads();
    // The shape a client portal or the ADR 1099 collaborator lane passes: a subject,
    // but no membership established at a door.
    for (const caller of [{ subject: t.userId }, { subject: undefined }]) {
      const rows = await listThread(t.tenantId, t.orgId, 'cms_page', t.target.resourceId, caller);
      expect(rows?.map((c) => c.commentId)).toEqual([t.shared.commentId, t.sharedReply.commentId]);
      expect(JSON.stringify(rows)).not.toContain('Margin on the cabinets');
    }
  });

  it('by id, an internal root and an internal reply read as missing to a non-member; shared ones do not', async () => {
    const t = await threads();
    const outsider = { subject: t.userId };
    expect(await getComment(t.tenantId, t.orgId, t.internal.commentId, outsider)).toBeNull();
    expect(await getComment(t.tenantId, t.orgId, t.internalReply.commentId, outsider)).toBeNull();
    expect((await getComment(t.tenantId, t.orgId, t.shared.commentId, outsider))?.commentId).toBe(t.shared.commentId);
    expect((await getComment(t.tenantId, t.orgId, t.sharedReply.commentId, outsider))?.commentId).toBe(t.sharedReply.commentId);
    // Non-vacuity: a member reads the internal one by id.
    expect((await getComment(t.tenantId, t.orgId, t.internal.commentId, { subject: t.userId, audience: 'member' }))?.commentId).toBe(t.internal.commentId);
  });

  it('erasure and pruning read the store, so internal comments are removed too (never filtered away)', async () => {
    const t = await threads();
    // Subject erasure: every comment the owner wrote goes, internal ones included.
    await deleteSubjectComments(t.tenantId, t.userId);
    expect((await __commentsForTenant(t.tenantId)).filter((c) => c.authorId === t.userId)).toEqual([]);
    // Resource deletion: every thread on the page goes, internal ones included.
    const u = await threads();
    await pruneThreadsForResourceAndComposites(u.tenantId, 'cms_page', u.target.resourceId);
    expect((await __commentsForTenant(u.tenantId)).filter((c) => c.resourceId === u.target.resourceId)).toEqual([]);
  });

  it('every caller marked as a member is a reviewed door', () => {
    const SRC = join(__dirname, '..', 'src');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p); }
      return out;
    };
    const sites = walk(SRC).filter((f) => /audience: 'member'/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f)).sort();
    // Each establishes org membership before it reads: the routes' org scope, the chat
    // tool's resolveReadOrgScope, the surface's requireOrg, and recipients already
    // filtered to members. A new site must say how it knows the caller is a member.
    expect(sites).toEqual([
      'features/comments/agentTools.ts',
      'features/comments/commentsService.ts',
      'features/comments/routes.ts',
      'features/comments/surface.ts',
    ]);
  });
});
