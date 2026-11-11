/**
 * DeckTalk ask 4 (2026-11-10): a public page read 404'd for 1–2 minutes after
 * the page was published.
 *
 * Cause, MEASURED on app.openwop.dev: the error envelope sets no Cache-Control,
 * and the hosting CDN then serves the public 404 with `cache-control:
 * max-age=600` (Cloud Run's own response carries none). A visitor, or the
 * author checking the slug just before pressing Publish, kept the cached 404.
 * The page read is not memoized in the backend, so the fix is an explicit
 * `no-store` on every not-found from the public slug reads (JSON, `.md`, and
 * the crawler prerender). Nothing else about the read's cache posture changes.
 *
 * This test pins three things:
 *   1. the 404 before publish says `no-store`;
 *   2. the SAME URL serves the page right after publish (no backend memo);
 *   3. an unknown org's 404 says `no-store` too.
 *
 * Sabotage-witnessed: removing `notFoundNoStore(res, err)` from the JSON route
 * reds case 1 (the header is absent).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
function client(): { post: <T>(p: string, b?: unknown) => Promise<Res<T>> } {
  let cookie = '';
  const post = async <T>(path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { post };
}

const pub = (orgId: string, s: string): string => `${BASE}/host/openwop-app/public/${encodeURIComponent(orgId)}${s}`;

describe('public slug reads: a not-found is never cacheable, so a publish is visible at once', () => {
  it('404 before publish says no-store, and the same URL serves the page right after publish', async () => {
    const c = client();
    const login = await c.post('/host/openwop-app/test/login', { email: `nostore-${Date.now()}@acme.test`, tenantId: `org:nostore-${Date.now()}` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId;
    const cms = `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}`;

    const created = await c.post<{ pageId: string; slug: string }>(`${cms}/pages`, {
      title: 'Launch notes', sections: [{ type: 'richText', data: { body: 'Hello.' } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const slug = created.body.slug;
    expect(slug).toMatch(/\S/);

    // The draft is invisible by slug: 404, and NOT cacheable.
    for (const path of [`/pages/${slug}`, `/pages/${slug}.md`]) {
      const before = await fetch(pub(orgId, path));
      expect(before.status, path).toBe(404);
      expect(before.headers.get('cache-control'), `${path}: the 404 must not be stored`).toBe('no-store');
    }

    expect((await c.post(`${cms}/pages/${created.body.pageId}/publish`)).status).toBe(200);

    const after = await fetch(pub(orgId, `/pages/${slug}`));
    expect(after.status, 'no backend memo holds the old not-found').toBe(200);
    expect(((await after.json()) as { title: string }).title).toBe('Launch notes');
    // The found page keeps its existing posture (this change touches only the 404).
    expect(after.headers.get('cache-control')).not.toBe('no-store');
  });

  it('an unknown org 404 says no-store too', async () => {
    const res = await fetch(pub('org-that-does-not-exist', '/pages/anything'));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
