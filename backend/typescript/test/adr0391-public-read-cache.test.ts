/**
 * ADR 0384 SEO-2 + ADR 0391 BLOG-1 — the TTL'd, bounded public-read memo.
 *  - unit: the `TtlLruCache` primitive expires on TTL and bounds entries (LRU);
 *  - integration: the `/blog` list (which rides `listPublishedWithSeo`) serves a
 *    memoized result within the TTL — a post published AFTER the first read is
 *    NOT visible until the cache is dropped (proving the second read did not
 *    rescan), and with the TTL disabled every read rescans.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { TtlLruCache } from '../src/features/publishing/publicReadCache.js';
import { __resetPublicReadCaches } from '../src/features/publishing/publishingService.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TtlLruCache primitive', () => {
  it('expires an entry after the TTL', async () => {
    const c = new TtlLruCache<string>(() => 40, 10);
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
    await sleep(60);
    expect(c.get('k')).toBeUndefined();
    expect(c.size).toBe(0); // the expired slot is dropped on read
  });

  it('a TTL of 0 disables the cache (every get misses)', () => {
    const c = new TtlLruCache<string>(() => 0, 10);
    c.set('k', 'v');
    expect(c.get('k')).toBeUndefined();
  });

  it('bounds entry count (LRU eviction of the oldest)', () => {
    const c = new TtlLruCache<number>(() => 10_000, 3);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.set('d', 4); // over the bound → evict 'a'
    expect(c.size).toBe(3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toBe(4);
  });

  it('a get bumps recency so the bumped key survives eviction', () => {
    const c = new TtlLruCache<number>(() => 10_000, 3);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBe(1); // bump 'a' to most-recent → 'b' is now oldest
    c.set('d', 4);              // evict the oldest ('b')
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
  });
});

// ── integration: the /blog list memo ──────────────────────────────────────────

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_PUBLIC_LIST_TTL_S; __resetPublicReadCaches(); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

const cms = (orgId: string, sfx = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${sfx}`;

async function seedOrgWithPost(): Promise<{ orgId: string; owner: ReturnType<typeof client> }> {
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `cache-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Cache Co' });
  const orgId = org.body.orgId as string;
  await publishPost(owner, orgId, 'First Post');
  return { orgId, owner };
}
async function publishPost(owner: ReturnType<typeof client>, orgId: string, title: string): Promise<void> {
  const created = await owner.post(cms(orgId, '/pages'), { title, kind: 'post', sections: [{ type: 'hero', data: { heading: title } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await owner.post(cms(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
}
const blogTitles = async (orgId: string): Promise<string[]> =>
  ((await client().get(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog`)).body.posts as Array<{ title: string }>).map((p) => p.title);

describe('BLOG-1 — the /blog list memo', () => {
  it('serves a memoized result within the TTL (a later publish is hidden until the cache drops)', async () => {
    const { orgId, owner } = await seedOrgWithPost();
    __resetPublicReadCaches(); // clean start (default 60s TTL)
    expect(await blogTitles(orgId)).toEqual(['First Post']); // populates the memo

    await publishPost(owner, orgId, 'Second Post'); // published AFTER the memo filled
    expect(await blogTitles(orgId)).toEqual(['First Post']); // cache hit — no rescan

    __resetPublicReadCaches(); // TTL-only invalidation, proven by the drop
    expect((await blogTitles(orgId)).sort()).toEqual(['First Post', 'Second Post']);
  });

  it('with the TTL disabled (0), every read rescans', async () => {
    process.env.OPENWOP_PUBLIC_LIST_TTL_S = '0';
    const { orgId, owner } = await seedOrgWithPost();
    __resetPublicReadCaches();
    expect(await blogTitles(orgId)).toEqual(['First Post']);
    await publishPost(owner, orgId, 'Second Post');
    // TTL=0 → the memo entry is born expired → the new post is immediately visible.
    expect((await blogTitles(orgId)).sort()).toEqual(['First Post', 'Second Post']);
  });
});
