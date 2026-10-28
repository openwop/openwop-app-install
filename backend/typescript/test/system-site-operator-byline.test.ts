/**
 * The system site's public byline names the HOST OPERATOR, and nobody else
 * (David's ruling, 2026-10-26).
 *
 * The first post on myndhyve.ai's system site read "By 0b39f331": its author
 * is resolved in the site's tenant (`host:site`), and the operator's user
 * record lives in their personal tenant, so the tenant-scoped lookup missed
 * and fell back to an id fragment. #5277 removed the fragment (no byline);
 * this restores the operator's real name. The system site is the operator's
 * own marketing site and only superadmins author there, so naming an
 * allowlisted operator exposes nobody else's profile. Everyone else, and
 * every other org, keeps "no name we cannot resolve in-tenant".
 *
 * Sabotage-witnessed: with the operator lookup removed from
 * `resolveAuthorNames`, the first case goes red (no authorName); with the
 * allowlist check removed from the users feature's operator resolver, the
 * second case goes red (the non-operator is named).
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { __resetPublicReadCaches } from '../src/features/publishing/publishingService.js';

let BASE: string;
let server: Server;
let n = 0;
const savedAllow = process.env.OPENWOP_SUPERADMIN_TENANTS;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  if (savedAllow === undefined) delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  else process.env.OPENWOP_SUPERADMIN_TENANTS = savedAllow;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T> { status: number; body: T }
type Call = <T>(method: string, path: string, body?: unknown) => Promise<Res<T>>;
interface LoggedIn { call: Call; userId: string; tenantId: string }

/** A signed-in person in their own personal tenant (the test seam's default). */
async function login(displayName: string): Promise<LoggedIn> {
  let cookie = '';
  const call: Call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  const res = await call<{ user: { userId: string; tenantId: string } }>('POST', '/host/openwop-app/test/login', { email: `ssb-${Date.now()}-${n++}@x.test`, displayName });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { call, userId: res.body.user.userId, tenantId: res.body.user.tenantId };
}

async function publishPost(who: LoggedIn, orgId: string, title: string, authorId?: string): Promise<void> {
  const base = `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}`;
  const created = await who.call<{ pageId: string }>('POST', `${base}/pages`, {
    title, kind: 'post', ...(authorId ? { authorId } : {}), sections: [{ type: 'richText', data: { body: 'Hello.' } }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pub = await who.call('POST', `${base}/pages/${created.body.pageId}/publish`);
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
}

interface BlogPost { title: string; authorName?: string }
async function postNamed(orgId: string, title: string): Promise<BlogPost> {
  __resetPublicReadCaches(); // the published-list memo would hide a post made by an earlier case
  const res = await fetch(`${BASE}/host/openwop-app/public/${encodeURIComponent(orgId)}/blog`);
  expect(res.status).toBe(200);
  const post = ((await res.json()) as { posts: BlogPost[] }).posts.find((p) => p.title === title);
  expect(post, `post "${title}" is listed`).toBeDefined();
  return post!;
}
async function feedCreators(orgId: string): Promise<string[]> {
  __resetPublicReadCaches();
  const res = await fetch(`${BASE}/host/openwop-app/public/${encodeURIComponent(orgId)}/blog/feed.xml`);
  expect(res.status).toBe(200);
  return [...(await res.text()).matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)].map((m) => m[1]!);
}

describe('system site byline — the host operator is named, nobody else', () => {
  it('names an allowlisted operator who posts on the system site (list + RSS)', async () => {
    const op = await login('Host Operator');
    process.env.OPENWOP_SUPERADMIN_TENANTS = op.tenantId;
    await publishPost(op, 'host-site', 'Operator post');
    expect((await postNamed('host-site', 'Operator post')).authorName).toBe('Host Operator');
    expect(await feedCreators('host-site')).toContain('Host Operator');
  });

  it('a system-site post whose author is NOT on the allowlist has no byline', async () => {
    const op = await login('Host Operator Two');
    const other = await login('Not The Operator');
    process.env.OPENWOP_SUPERADMIN_TENANTS = op.tenantId;
    await publishPost(op, 'host-site', 'Ghost-written post', other.userId);
    const post = await postNamed('host-site', 'Ghost-written post');
    expect(post).not.toHaveProperty('authorName');
    expect(await feedCreators('host-site')).not.toContain('Not The Operator');
  });

  it('another org is unchanged: an operator credited on a tenant they are not in stays unnamed', async () => {
    const op = await login('Host Operator Three');
    const owner = await login('Org Owner');
    process.env.OPENWOP_SUPERADMIN_TENANTS = op.tenantId;
    const org = await owner.call<{ orgId: string }>('POST', '/host/openwop-app/orgs', { name: 'Elsewhere' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    await publishPost(owner, org.body.orgId, 'Credited elsewhere', op.userId);
    expect(await postNamed(org.body.orgId, 'Credited elsewhere')).not.toHaveProperty('authorName');
    expect(await feedCreators(org.body.orgId)).toEqual([]);
  });
});
