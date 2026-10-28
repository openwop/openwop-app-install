/**
 * ADR 0384 SEO-2 + ADR 0391 BLOG-1 — the TTL'd, bounded public-read memo.
 *  - unit: the `TtlLruCache` primitive expires on TTL and bounds entries (LRU);
 *  - integration: the `/blog` list (which rides `listPublishedWithSeo`) serves a
 *    memoized result within the TTL — a post published AFTER the first read is
 *    NOT visible until the cache is dropped (proving the second read did not
 *    rescan), and with the TTL disabled every read rescans.
 *
 * TST-BQR-10. Red when: a slot never expires; a TTL of 0 is honoured as a
 * cache; the LRU bound is off by one or a get does not bump recency; the
 * `/blog` list read skips the memo; `OPENWOP_PUBLIC_LIST_TTL_S=0` falls back
 * to the 60 s default.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { TtlLruCache } from '../src/features/publishing/publicReadCache.js';
import { __resetPublicReadCaches } from '../src/features/publishing/publishingService.js';

describe('TtlLruCache primitive', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('expires an entry after the TTL', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-07-01T00:00:00.000Z'));
    const c = new TtlLruCache<string>(() => 40, 10);
    c.set('k', 'v');
    vi.setSystemTime(Date.parse('2026-07-01T00:00:00.039Z'));
    expect(c.get('k')).toBe('v'); // 39 ms: still fresh
    vi.setSystemTime(Date.parse('2026-07-01T00:00:00.040Z'));
    expect(c.get('k')).toBeUndefined(); // 40 ms: expired
    expect(c.size).toBe(0); // the expired slot is dropped on read
  });

  it('a TTL of 0 disables the cache (every get misses)', () => {
    const c = new TtlLruCache<string>(() => 0, 10);
    c.set('k', 'v');
    expect(c.get('k')).toBeUndefined();
  });

  it('bounds entry count (LRU eviction of the oldest)', () => {
    const c = new TtlLruCache<number>(() => 10_000, 3);
    const sizes: number[] = [];
    for (const [k, v] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) { c.set(k, v); sizes.push(c.size); }
    expect(sizes).toEqual([1, 2, 3, 3, 3]); // never over the bound, never under-filled
    expect(c.get('a')).toBeUndefined(); // the two oldest were evicted…
    expect(c.get('b')).toBeUndefined();
    expect([c.get('c'), c.get('d'), c.get('e')]).toEqual([3, 4, 5]); // …and only them
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

interface Res<T> { status: number; body: T }
interface OrgBody { orgId: string }
interface PageBody { pageId: string }
interface BlogBody { posts: Array<{ title: string }> }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

const cms = (orgId: string, sfx = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${sfx}`;

async function seedOrgWithPost(): Promise<{ orgId: string; owner: ReturnType<typeof client> }> {
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `cache-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Cache Co' });
  const orgId = org.body.orgId;
  await publishPost(owner, orgId, 'First Post');
  return { orgId, owner };
}
async function publishPost(owner: ReturnType<typeof client>, orgId: string, title: string): Promise<void> {
  const created = await owner.post<PageBody>(cms(orgId, '/pages'), { title, kind: 'post', sections: [{ type: 'hero', data: { heading: title } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await owner.post(cms(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
}
const blogTitles = async (orgId: string): Promise<string[]> =>
  (await client().get<BlogBody>(`/host/openwop-app/public/${encodeURIComponent(orgId)}/blog`)).body.posts.map((p) => p.title);

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
