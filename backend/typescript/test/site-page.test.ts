/**
 * System home page via the collapsed CMS surface (ADR 0027) — the public front
 * page is a real CMS page in the reserved `host-site` org, edited by a super
 * admin through the STANDARD CMS routes (`requireCmsScope` grants host authority
 * for that one org). Publishing's SEO route composes the same guard so metadata
 * for that page is manageable without inventing a second system-site authority
 * rule. Asserts: the seeded page renders publicly; a super admin drives the full
 * CMS route family (list/read/edit/publish/versions/SEO) on it; a
 * malformed edit fails closed without taking the live homepage offline; and a
 * NORMAL signed-in user cannot reach the reserved org (tenant isolation intact).
 *
 * The bespoke `/site-page` route was retired in the collapse — editing now goes
 * through `/cms/orgs/host-site/*`, so there is no second edit path to test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;
/** Super-admin (wildcard bearer) drives the CMS route family on the reserved org. */
const cms = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}/v1/host/openwop-app/cms/orgs/host-site${path}`, {
    method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const publicHome = () => fetch(`${BASE}/v1/host/openwop-app/public/host-site/pages/home`);
const seo = (method: string, pageId: string, body?: unknown) =>
  fetch(`${BASE}/v1/host/openwop-app/publishing/orgs/host-site/pages/${encodeURIComponent(pageId)}/seo`, {
    method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const homeId = async (): Promise<string> => {
  const pages = (await j<{ pages: { slug: string; pageId: string }[] }>(await cms('GET', '/pages'))).pages;
  const home = pages.find((p) => p.slug === 'home');
  if (!home) throw new Error('seeded home page missing');
  return home.pageId;
};

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
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `sp-${n++}@x.test` });
  expect(login.status).toBe(201);
  return call;
}

describe('system home page — public render (unauthenticated)', () => {
  it('serves the seeded host-site home page to an anonymous visitor', async () => {
    await cms('GET', '/pages'); // ensure the site (boot also does this in prod)
    const res = await publicHome();
    expect(res.status).toBe(200);
    const page = await j<{ slug: string; sections: unknown[] }>(res);
    expect(page.slug).toBe('home');
    expect(page.sections.length).toBeGreaterThan(0);
  });
});

describe('front-page collapse — super admin drives the CMS route family on host-site (ADR 0027)', () => {
  it('lists + reads the seeded home page through /cms/orgs/host-site', async () => {
    const list = await cms('GET', '/pages');
    expect(list.status).toBe(200);
    const one = await cms('GET', `/pages/${await homeId()}`);
    expect(one.status).toBe(200);
  });

  it('edits the published home page via the standard CMS PATCH — the change goes live in place', async () => {
    const saved = await cms('PATCH', `/pages/${await homeId()}`, {
      title: 'Home', sections: [{ type: 'hero', data: { heading: 'CMS-driven front page' } }],
    });
    expect(saved.status).toBe(200);
    const live = await j<{ sections: { data: { heading?: string } }[] }>(await publicHome());
    expect(live.sections[0]?.data?.heading).toBe('CMS-driven front page');
  });

  it('runs the draft→publish transition on a host-site page (unpublish → publish round-trip)', async () => {
    const id = await homeId();
    expect((await cms('POST', `/pages/${id}/unpublish`)).status).toBe(200);
    const draft = await j<{ status: string }>(await cms('GET', `/pages/${id}`));
    expect(draft.status).toBe('draft');
    expect((await cms('POST', `/pages/${id}/publish`)).status).toBe(200);
  });

  it('lists page versions on host-site (capability the bespoke editor lacked)', async () => {
    const versions = await cms('GET', `/pages/${await homeId()}/versions`);
    expect(versions.status).toBe(200);
  });

  it('writes + reads SEO metadata for the reserved host-site page', async () => {
    const id = await homeId();
    const saved = await seo('PUT', id, {
      metaTitle: 'KickTodo — One meaningful action today',
      metaDescription: 'Choose a guided challenge and take the next useful step.',
      canonicalUrl: 'https://kicktodo.com/',
      noindex: false,
    });
    expect(saved.status).toBe(200);
    expect((await j<{ seo: { metaTitle?: string } }>(saved)).seo.metaTitle).toBe('KickTodo — One meaningful action today');

    const read = await seo('GET', id);
    expect(read.status).toBe(200);
    expect((await j<{ seo: { canonicalUrl?: string } }>(read)).seo.canonicalUrl).toBe('https://kicktodo.com/');
  });

  it('a malformed edit 400s WITHOUT taking the live homepage offline', async () => {
    const id = await homeId();
    // establish a known-good published state
    await cms('PATCH', `/pages/${id}`, { sections: [{ type: 'hero', data: { heading: 'Live' } }] });
    // malformed sections (not an array) → 400; the in-place edit never commits, so the page stays live
    const bad = await cms('PATCH', `/pages/${id}`, { sections: { not: 'an array' } });
    expect(bad.status).toBe(400);
    const pub = await publicHome();
    expect(pub.status).toBe(200);
    expect((await j<{ sections: { data: { heading?: string } }[] }>(pub)).sections[0]?.data?.heading).toBe('Live');
  });
});

describe('system home page — authority + isolation', () => {
  it('hides the reserved system org from a normal user via the org-scoped CMS routes (404, cross-tenant)', async () => {
    const call = await normalClient();
    // requireCmsScope: a non-superadmin gets the same 404 any foreign org yields,
    // so the reserved org's editability stays invisible in the CMS namespace.
    expect((await call('GET', '/v1/host/openwop-app/cms/orgs/host-site/pages')).status).toBe(404);
    expect((await call('POST', '/v1/host/openwop-app/cms/orgs/host-site/pages', { title: 'X' })).status).toBe(404);
    const pageId = await homeId();
    expect((await call('GET', `/v1/host/openwop-app/publishing/orgs/host-site/pages/${encodeURIComponent(pageId)}/seo`)).status).toBe(404);
    expect((await call('PUT', `/v1/host/openwop-app/publishing/orgs/host-site/pages/${encodeURIComponent(pageId)}/seo`, { metaTitle: 'X' })).status).toBe(404);
  });
});
