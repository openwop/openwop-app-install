/**
 * System home-page editor (ADR 0027, Option A) — the host-level homepage a super
 * admin edits regardless of org/tenant. Asserts: the seeded page renders publicly;
 * a super admin (wildcard bearer) reads + edits it; a non-superadmin is 403; and a
 * NORMAL signed-in user cannot reach the reserved system org via the org-scoped CMS
 * routes (tenant isolation intact).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

const PORT = 8801;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { authorization: 'Bearer sample-token', 'content-type': 'application/json' };
let server: Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const sp = (method: string, body?: unknown) =>
  fetch(`${BASE}/v1/host/sample/site-page`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function normalClient(): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return res;
  };
  const login = await call('POST', '/v1/host/sample/test/login', { email: `sp-${n++}@x.test` });
  expect(login.status).toBe(201);
  return call;
}

describe('system home page — public render (unauthenticated)', () => {
  it('serves the seeded host-site home page to an anonymous visitor', async () => {
    // touch the editor once so the site is ensured (boot also does this in prod)
    await sp('GET');
    const res = await fetch(`${BASE}/v1/host/sample/public/host-site/pages/home`);
    expect(res.status).toBe(200);
    const page = await j<{ slug: string; sections: unknown[] }>(res);
    expect(page.slug).toBe('home');
    expect(page.sections.length).toBeGreaterThan(0);
  });
});

describe('system home page — super admin edit', () => {
  it('reads the working page and edits it cross-tenant by host authority', async () => {
    const got = await j<{ page: { pageId: string; slug: string } }>(await sp('GET'));
    expect(got.page.slug).toBe('home');

    const edited = await sp('PUT', { title: 'Welcome', sections: [{ type: 'hero', data: { heading: 'Edited by super admin' } }] });
    expect(edited.status).toBe(200);
    const page = (await j<{ page: { status: string; sections: { data: { heading?: string } }[] } }>(edited)).page;
    expect(page.status).toBe('published');
    expect(page.sections[0]?.data?.heading).toBe('Edited by super admin');

    // the edit is live on the public surface
    const pub = await j<{ sections: { data: { heading?: string } }[] }>(await fetch(`${BASE}/v1/host/sample/public/host-site/pages/home`));
    expect(pub.sections[0]?.data?.heading).toBe('Edited by super admin');
  });
});

describe('system home page — authority + isolation', () => {
  it('forbids a non-superadmin (403)', async () => {
    const call = await normalClient();
    expect((await call('GET', '/v1/host/sample/site-page')).status).toBe(403);
    expect((await call('PUT', '/v1/host/sample/site-page', { sections: [] })).status).toBe(403);
  });

  it('a malformed edit 400s WITHOUT taking the live homepage offline', async () => {
    // ensure a good published page first
    await sp('PUT', { sections: [{ type: 'hero', data: { heading: 'Live' } }] });
    // malformed sections (not an array) → 400, and the page must STAY published
    const bad = await sp('PUT', { sections: { not: 'an array' } });
    expect(bad.status).toBe(400);
    const pub = await fetch(`${BASE}/v1/host/sample/public/host-site/pages/home`);
    expect(pub.status).toBe(200); // still live (validate-before-unpublish)
    expect((await j<{ sections: { data: { heading?: string } }[] }>(pub)).sections[0]?.data?.heading).toBe('Live');
  });

  it('hides the reserved system org from a normal user via the org-scoped CMS routes (404, cross-tenant)', async () => {
    const call = await normalClient();
    // requireOrgScope: host-site is not in the caller's tenant ⇒ 404, never editable.
    expect((await call('GET', '/v1/host/sample/cms/orgs/host-site/pages')).status).toBe(404);
    expect((await call('POST', '/v1/host/sample/cms/orgs/host-site/pages', { title: 'X' })).status).toBe(404);
  });
});
