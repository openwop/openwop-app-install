/**
 * ADR 0813 — the system-site launch post seed + the CMS accommodations it needed:
 *  - the post seeds as a DRAFT `kind:'post'` (never auto-published), with its two
 *    diagrams as PNG media rows and the second one as the social card;
 *  - the seed is idempotent (no duplicate media rows on re-run);
 *  - once published, the crawler HTML gives the post its `<h1>` (post chrome, not
 *    a section), Article JSON-LD with `datePublished`, and the prose block grammar
 *    (`<h3>` subheadings, `<ul>`/`<ol>` lists).
 * Tracker: TST-BNC-1.
 *
 * Each case seeds its OWN fresh post (`seedFresh`: delete the page and the
 * seed marker, then run the real ensure), so no case depends on another's
 * publish, and a seed failure fails the case instead of skipping the file.
 *
 * Red when (wave 60 probes w60g4-blog-*, byline-me): the post is not seeded as
 * a `post`; a re-seed adds media rows (the dedupe by name); the social card is
 * not one of the post's images; the crawler HTML loses the post `<h1>` or
 * `datePublished`; `authorId: "me"` is not resolved to the caller.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { ensureSystemSiteBlog, __resetSystemSiteBlogEnsure, LAUNCH_POST_PAGE_ID, LAUNCH_POST_SLUG } from '../src/host/systemSiteBlog.js';
import { deletePage, getPage, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { getSeo } from '../src/features/publishing/publishingService.js';
import { prerenderPage } from '../src/features/publishing/prerenderService.js';
import { listAssets } from '../src/features/media/mediaService.js';
import { SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import { getSetCookies } from './headerCookies.js';
import { deleteConfig, getStoredConfig, saveConfig } from '../src/host/featureToggles/service.js';
import type { ToggleConfig } from '../src/host/featureToggles/types.js';
import type { Storage } from '../src/storage/storage.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let savedUsersToggle: ToggleConfig | null = null;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  savedUsersToggle = await getStoredConfig('users');
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => {
  if (savedUsersToggle) await saveConfig(savedUsersToggle, 'test'); else await deleteConfig('users', 'test');
  await new Promise<void>((res) => server.close(() => res()));
});

/** A fresh, untouched system draft: drop the post and the seed marker, then run
 *  the real ensure (boot fires it async; awaited here, inside the case). The
 *  media rows are KEPT, so a re-seed exercises the by-name dedupe. */
async function seedFresh(): Promise<void> {
  await settleBootEnsure();
  await deletePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID);
  await storage.kvDelete('hostext:systemsite:blog-seed:seed');
  __resetSystemSiteBlogEnsure();
  await ensureSystemSiteBlog();
}
/** The boot-time ensure may still be in flight; join it before resetting. */
async function settleBootEnsure(): Promise<void> { await ensureSystemSiteBlog(); }

const seedAssets = async () => (await listAssets(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG)).filter((a) => a.uploadedBy === 'system:blog-seed');


/** ADR 0836 D9 — the seed's `[TODO …]` markers are publish blockers now (the
 *  server half of the editor checklist). These tests are about what happens
 *  AFTER the author finishes the post, so finish it first. */
async function finishTodos(): Promise<void> {
  const p = (await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID))!;
  const scrub = (v: unknown): unknown => typeof v === 'string' ? v.replace(/`?\[TODO[^\]]*\]`?/gi, '') : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, { sections: p.sections.map((s) => ({ ...s, data: scrub(s.data) as Record<string, unknown> })) }, 'user:author');
}

describe('ADR 0813 — the launch post seed', () => {
  it('seeds a DRAFT blog post that the public blog does not list', async () => {
    await seedFresh();
    const page = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID);
    expect(page?.status).toBe('draft');
    expect(page?.kind).toBe('post');
    expect(page?.slug).toBe(LAUNCH_POST_SLUG);
    expect(page?.title).toBe('10x Your Company = Your Team + AI Agents');
    const res = await fetch(`${BASE}/host/openwop-app/public/${SYSTEM_SITE_ORG}/blog`);
    const { posts } = (await res.json()) as { posts: Array<{ slug: string }> };
    expect(posts.map((p) => p.slug)).not.toContain(LAUNCH_POST_SLUG);
  });

  it('stores both diagrams as PNG media rows, referenced by the image sections and the social card', async () => {
    await seedFresh();
    const assets = await seedAssets();
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.contentType === 'image/png')).toBe(true);
    const page = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID);
    const imageTokens = page!.sections.filter((s) => s.type === 'image').map((s) => (s.data as { token: string }).token);
    expect(new Set(imageTokens)).toEqual(new Set(assets.map((a) => a.serveToken)));
    const seo = await getSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID);
    expect(imageTokens).toContain(seo?.ogImageToken);
    expect(seo?.metaDescription).toMatch(/one person run a company/);
  });

  it('is idempotent: a re-run adds no media rows', async () => {
    await seedFresh();
    expect(await seedAssets()).toHaveLength(2);
    // A second full seed (marker cleared, so the diagram step runs again)
    // reuses the stored rows by name instead of uploading two more.
    await seedFresh();
    expect(await seedAssets()).toHaveLength(2);
  });

  it('once published, the crawler HTML has the post <h1>, Article JSON-LD and the prose blocks', async () => {
    await seedFresh();
    await finishTodos();
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, 'publish', 'user:editor');
    const result = await prerenderPage(SYSTEM_SITE_ORG, LAUNCH_POST_SLUG, 'https://app.test', null);
    expect(result).not.toBeNull();
    const html = result!.html;
    expect(html).toContain('<h1>10x Your Company = Your Team + AI Agents</h1>');
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('"datePublished"');
    expect(html).toContain('<h3>Software development: working code is the second artifact</h3>');
    expect(html).toMatch(/<ul><li><strong>Human to human:<\/strong>/);
    expect(html).toMatch(/<ol><li><strong>They lose the why\.<\/strong>/);
  });
});

describe('ADR 0813 — the editor sets the byline with authorId "me"', () => {
  it('resolves "me" to the caller on create and patch, and null clears it', async () => {
    let cookie = '';
    interface PageBody { pageId: string; authorId?: string; createdBy: string; category?: string; orgId?: string }
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: PageBody }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as PageBody };
    };
    await call('POST', '/host/openwop-app/test/login', { email: `byline-${Date.now()}@acme.test` });
    const org = await call('POST', '/host/openwop-app/orgs', { name: 'Byline Co' });
    const base = `/host/openwop-app/cms/orgs/${encodeURIComponent(org.body.orgId ?? '')}/pages`;
    const created = await call('POST', base, { title: 'A post', kind: 'post', authorId: 'me', sections: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.authorId).toBe(created.body.createdBy);
    const cleared = await call('PATCH', `${base}/${created.body.pageId}`, { authorId: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.authorId).toBeUndefined();
    const reset = await call('PATCH', `${base}/${created.body.pageId}`, { authorId: 'me', category: 'Field Notes' });
    expect(reset.body.authorId).toBe(created.body.createdBy);
    expect(reset.body.category).toBe('field-notes');
  });
});
