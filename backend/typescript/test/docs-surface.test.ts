/**
 * Product docs surface (ADR 0392 Phase 1) — the CMS docs collection + public
 * /docs nav tree + the SEO exclusion. Verifies: a `collection:'docs'` page is
 * authored/published through the normal CMS flow; the public docs nav tree
 * lists only published docs (ordered by docsNav); docs pages are EXCLUDED from
 * the marketing sitemap/RSS but SERVED at their public slug; and the docs nav
 * 404s when the `docs` toggle is off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function setDocs(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('docs');
  expect(d, 'docs toggle must be declared').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}
// The public routes return XML/text, not JSON — a raw fetch helper.
async function raw(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, text: await res.text() };
}

async function ownerOrg(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:docs-${Date.now()}-${n++}`;
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `docs-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const cms = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function publishPage(owner: Client, orgId: string, body: Record<string, unknown>): Promise<{ pageId: string; slug: string }> {
  const create = await owner.post(cms(orgId, '/pages'), body);
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const { pageId, slug } = create.body;
  const pub = await owner.post(cms(orgId, `/pages/${pageId}/publish`));
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return { pageId, slug };
}

describe('ADR 0392 Phase 1 — docs collection + public tier + SEO exclusion', () => {
  it('lists only published docs in the nav tree (ordered), excludes them from sitemap, serves them by slug', async () => {
    await setDocs('on');
    const { owner, orgId } = await ownerOrg();

    const marketing = await publishPage(owner, orgId, { title: 'Pricing', slug: 'pricing', sections: [{ type: 'hero', data: { heading: 'Plans' } }] });
    const docB = await publishPage(owner, orgId, { title: 'B Guide', slug: 'b-guide', collection: 'docs', docsNav: '20', sections: [{ type: 'hero', data: { heading: 'B' } }] });
    const docA = await publishPage(owner, orgId, { title: 'A Guide', slug: 'a-guide', collection: 'docs', docsNav: '10', sections: [{ type: 'hero', data: { heading: 'A' } }] });
    // a DRAFT docs page must not appear
    const draftDoc = await owner.post(cms(orgId, '/pages'), { title: 'Draft Doc', slug: 'draft-doc', collection: 'docs', sections: [] });
    expect(draftDoc.status).toBe(201);

    // nav tree: published docs only, ordered by docsNav (10 before 20), marketing absent
    const nav = await client().get(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/docs`);
    expect(nav.status).toBe(200);
    expect(nav.body.docs.map((d: { slug: string }) => d.slug)).toEqual([docA.slug, docB.slug]);

    // sitemap EXCLUDES docs, INCLUDES the marketing page
    const sitemap = await raw(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain(marketing.slug);
    expect(sitemap.text).not.toContain(docA.slug);
    expect(sitemap.text).not.toContain(docB.slug);

    // but the doc IS served at its public slug (docs are public)
    const served = await client().get(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(docA.slug)}`);
    expect(served.status).toBe(200);
  });

  // UX_UPGRADE-docs D-G6 — the freshness signal a reference doc lives on.
  it('the nav tree carries each doc’s updatedAt, and it MOVES when the doc is edited', async () => {
    await setDocs('on');
    const { owner, orgId } = await ownerOrg();
    const doc = await publishPage(owner, orgId, { title: 'Fresh Guide', slug: 'fresh-guide', collection: 'docs', docsNav: '10', sections: [{ type: 'hero', data: { heading: 'Fresh' } }] });

    const navUrl = `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/docs`;
    const before = (await client().get(navUrl)).body.docs.find((d: { slug: string }) => d.slug === doc.slug);
    expect(String(before.updatedAt)).toMatch(/\dT/);

    // Editing the doc must move the stamp — otherwise "last updated" lies.
    await new Promise((r) => setTimeout(r, 5));
    expect((await owner.patch(cms(orgId, `/pages/${doc.pageId}`), { title: 'Fresh Guide v2' })).status).toBe(200);
    const after = (await client().get(navUrl)).body.docs.find((d: { slug: string }) => d.slug === doc.slug);
    expect(new Date(String(after.updatedAt)).getTime()).toBeGreaterThan(new Date(String(before.updatedAt)).getTime());
  });

  it('the docs nav 404s when the docs toggle is OFF', async () => {
    const { orgId } = await ownerOrg();
    await setDocs('off');
    const nav = await client().get(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/docs`);
    expect(nav.status).toBe(404);
    await setDocs('on');
  });

  it('the CMS list filters by collection (docs vs site)', async () => {
    await setDocs('on');
    const { owner, orgId } = await ownerOrg();
    await publishPage(owner, orgId, { title: 'Marketing', slug: 'mk', sections: [] });
    await publishPage(owner, orgId, { title: 'Doc', slug: 'dk', collection: 'docs', sections: [] });
    const docsOnly = await owner.get(cms(orgId, '/pages?collection=docs'));
    expect(docsOnly.body.pages.map((p: { slug: string }) => p.slug)).toEqual(['dk']);
    const siteOnly = await owner.get(cms(orgId, '/pages?collection=site'));
    expect(siteOnly.body.pages.map((p: { slug: string }) => p.slug)).toEqual(['mk']);
  });
});
