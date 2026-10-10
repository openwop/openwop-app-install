/**
 * ADR 0836 — CMS publishing integrity and exits (feature loop 2026-10 row 22).
 *
 * Every `describe` below was written against `origin/main` @ `48fcab3b2` FIRST and
 * went RED there (the run is recorded in the ADR's implementation record), then
 * green on the fix. Route-level where authority is the question (it is only
 * observable at the HTTP boundary); service-level where the defect is in the
 * store or the sweep.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  createPage, getPage, listVersions, transitionPage, updatePage, setScheduledPublish, restoreVersion,
} from '../src/features/cms/cmsService.js';
import { processScheduledPublishes } from '../src/features/cms/publishSweep.js';
import { onCmsPageLifecycle, type CmsPageLifecycleChange } from '../src/host/cmsPageLifecycle.js';
import { prerenderPageCached } from '../src/features/publishing/prerenderService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `a0836-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const cms = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const seo = (orgId: string, pageId: string): string =>
  `/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;

async function ownerWithEditor(): Promise<{ owner: Client; editor: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:a0836-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const editor = client();
  const editorUser = await signup(editor, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorUser.userId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, editor, orgId, tenantId };
}

async function httpPage(c: Client, orgId: string, title: string, publish: boolean): Promise<string> {
  const r = await c.post(cms(orgId, '/pages'), { title, sections: [{ type: 'hero', data: { heading: title } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (publish) expect((await c.post(cms(orgId, `/pages/${encodeURIComponent(r.body.pageId)}/publish`))).status).toBe(200);
  return r.body.pageId as string;
}

const hero = (heading: string) => [{ type: 'hero', data: { heading } }];

// ── D4 — rows keyed by pageId alone ──────────────────────────────────────────

describe('ADR 0836 D4 — version history is per tenant', () => {
  it("tenant B publishing a page with tenant A's id neither promotes nor swallows A's history", async () => {
    const id = `shared-id-${n++}`;
    const a = await createPage({ tenantId: 't-a836', orgId: 'o-a', title: 'A', pageId: id, sections: hero('A'), createdBy: 'ua' });
    await transitionPage(a.tenantId, a.orgId, id, 'submit', 'ua'); // A: a `submit` capture of v1
    const b = await createPage({ tenantId: 't-b836', orgId: 'o-b', title: 'B', pageId: id, sections: hero('B'), createdBy: 'ub' });
    await transitionPage(b.tenantId, b.orgId, id, 'publish', 'ub'); // B: v1 publish

    const aHist = await listVersions('t-a836', 'o-a', id);
    expect(aHist).toHaveLength(1);
    expect(aHist[0]!.origin).toBe('submit'); // not promoted by another tenant's publish
    const bHist = await listVersions('t-b836', 'o-b', id);
    expect(bHist).toHaveLength(1); // B got its own capture
    expect(bHist[0]!.snapshot.title).toBe('B');
  });
});

describe('ADR 0836 D4 — schedule markers are per tenant', () => {
  it("tenant B scheduling the same page id does not drop tenant A's schedule", async () => {
    const id = `sched-id-${n++}`;
    await createPage({ tenantId: 't-a836s', orgId: 'o-a', title: 'A', pageId: id, sections: hero('A'), createdBy: 'ua' });
    await createPage({ tenantId: 't-b836s', orgId: 'o-b', title: 'B', pageId: id, sections: hero('B'), createdBy: 'ub' });
    const at = new Date(Date.now() + 60_000).toISOString();
    await setScheduledPublish('t-a836s', 'o-a', id, at, 'ua');
    await setScheduledPublish('t-b836s', 'o-b', id, at, 'ub');
    await processScheduledPublishes(Date.now() + 120_000);
    expect((await getPage('t-a836s', 'o-a', id))?.status).toBe('published');
    expect((await getPage('t-b836s', 'o-b', id))?.status).toBe('published');
  });
});

// ── D1 — the version pin is a precondition on the write ─────────────────────

describe('ADR 0836 D1 — expectedVersion is a compare-and-set', () => {
  it('two concurrent saves pinned to the same version: exactly one lands', async () => {
    const p = await createPage({ tenantId: 't-cas836', orgId: 'o', title: 'Race', sections: hero('v1'), createdBy: 'u' });
    const results = await Promise.allSettled([
      updatePage(p.tenantId, p.orgId, p.pageId, { title: 'Writer one' }, 'u1', { expectedVersion: 1 }),
      updatePage(p.tenantId, p.orgId, p.pageId, { title: 'Writer two' }, 'u2', { expectedVersion: 1 }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'conflict');
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect((await getPage(p.tenantId, p.orgId, p.pageId))?.version).toBe(2);
  });
});

// ── D3 — a scheduled publish ships what was scheduled ───────────────────────

describe('ADR 0836 D3 — scheduled publish is pinned to the scheduled version', () => {
  it('an edit by a writer without publish authority cancels the schedule; the sweep publishes nothing', async () => {
    const p = await createPage({ tenantId: 't-pin836', orgId: 'o', title: 'Launch', sections: hero('Approved copy'), createdBy: 'admin' });
    await setScheduledPublish(p.tenantId, p.orgId, p.pageId, new Date(Date.now() + 60_000).toISOString(), 'admin');
    // The content-editor agent / an editor / the localize chain: no keepSchedule.
    await updatePage(p.tenantId, p.orgId, p.pageId, { sections: hero('Unreviewed machine copy') }, 'agent');
    const edited = await getPage(p.tenantId, p.orgId, p.pageId);
    expect(edited?.scheduledPublishAt).toBeUndefined(); // cancelled at edit time, visibly
    await processScheduledPublishes(Date.now() + 120_000);
    expect((await getPage(p.tenantId, p.orgId, p.pageId))?.status).toBe('draft');
  });
});

// ── D6 — live tier is one rule ──────────────────────────────────────────────

describe('ADR 0836 D6 — editor writes that change a live page need the admin tier (gate OFF)', () => {
  it("an editor cannot rewrite a PUBLISHED page's SEO (canonical, noindex)", async () => {
    const { owner, editor, orgId } = await ownerWithEditor();
    const id = await httpPage(owner, orgId, 'Live seo', true);
    const r = await editor.put(seo(orgId, id), { canonicalUrl: 'https://elsewhere.example/', noindex: true });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.details?.requiredScope).toBe('host:members:manage');
    expect(r.body.details?.reason).toBe('live_tier'); // the editor's copy keys on this
    expect((await owner.put(seo(orgId, id), { metaTitle: 'Owner may' })).status).toBe(200);
  });

  it('an editor cannot rewrite the content of a shared section a PUBLISHED page uses', async () => {
    const { owner, editor, orgId } = await ownerWithEditor();
    const sh = await owner.post(cms(orgId, '/shared-sections'), { name: 'Footer', type: 'richText', data: { heading: 'Footer', text: 'Old' } });
    expect(sh.status, JSON.stringify(sh.body)).toBe(201);
    const shId = sh.body.sharedSectionId as string;
    const pg = await owner.post(cms(orgId, '/pages'), { title: 'Uses footer', sections: [{ type: 'richText', ref: { sharedSectionId: shId }, data: {} }] });
    expect(pg.status, JSON.stringify(pg.body)).toBe(201);
    expect((await owner.post(cms(orgId, `/pages/${encodeURIComponent(pg.body.pageId)}/publish`))).status).toBe(200);
    const r = await editor.patch(cms(orgId, `/shared-sections/${encodeURIComponent(shId)}`), { data: { heading: 'Footer', text: 'Hijacked CTA' } });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    // A rename changes nothing a reader sees: editor tier.
    expect((await editor.patch(cms(orgId, `/shared-sections/${encodeURIComponent(shId)}`), { name: 'Footer v2' })).status).toBe(200);
  });
});

// ── D8 — restore is honest ──────────────────────────────────────────────────

describe('ADR 0836 D8 — restoring a version of a live page says the page went offline', () => {
  it('fires the `unpublished` lifecycle', async () => {
    const seen: CmsPageLifecycleChange[] = [];
    onCmsPageLifecycle('adr0836-test', async (e) => { seen.push(e); });
    const p = await createPage({ tenantId: 't-rst836', orgId: 'o', title: 'Doc', sections: hero('v1'), createdBy: 'u' });
    await transitionPage(p.tenantId, p.orgId, p.pageId, 'publish', 'u');
    const [v] = await listVersions(p.tenantId, p.orgId, p.pageId);
    await restoreVersion(p.tenantId, p.orgId, p.pageId, v!.versionId, 'u');
    await new Promise((r) => setTimeout(r, 20)); // lifecycle is fire-and-forget
    expect(seen.filter((e) => e.pageId === p.pageId).map((e) => e.event)).toEqual(['published', 'unpublished']);
  });
});

// ── D9 — publish blockers hold on the server ────────────────────────────────

describe('ADR 0836 D9 — a `[TODO …]` marker blocks publish on every lane', () => {
  it('direct publish refuses 422 (reason publish_blocked)', async () => {
    const p = await createPage({ tenantId: 't-blk836', orgId: 'o', title: 'Draft post', sections: [{ type: 'richText', data: { heading: 'H', text: 'Intro [TODO: the anecdote]' } }], createdBy: 'u' });
    await expect(transitionPage(p.tenantId, p.orgId, p.pageId, 'publish', 'u')).rejects.toMatchObject({ code: 'validation_error', httpStatus: 422, details: { reason: 'publish_blocked' } });
    expect((await getPage(p.tenantId, p.orgId, p.pageId))?.status).toBe('draft');
  });
});

// ── D7 — public exits ───────────────────────────────────────────────────────

describe('ADR 0836 D7 — the prerender memo never serves a request-derived origin to the next visitor', () => {
  it('a forged X-Forwarded-Host base does not poison the cached document', async () => {
    const { owner, orgId } = await ownerWithEditor();
    await httpPage(owner, orgId, 'Home', true);
    const r = await owner.get(cms(orgId, '/pages'));
    const slug = (r.body.pages as Array<{ slug: string }>)[0]!.slug;
    const evil = await prerenderPageCached(orgId, slug, 'https://evil.example', 'en');
    expect(evil?.html).toContain('evil.example');
    const next = await prerenderPageCached(orgId, slug, 'https://good.example', 'en');
    expect(next?.html).not.toContain('evil.example');
  });

  it('a CONFIGURED base still caches (the fix must not cost prod its memo)', async () => {
    const { owner, orgId } = await ownerWithEditor();
    const id = await httpPage(owner, orgId, 'Cached', true);
    const slug = ((await owner.get(cms(orgId, `/pages/${encodeURIComponent(id)}`))).body as { slug: string }).slug;
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://configured.example';
    try {
      const first = await prerenderPageCached(orgId, slug, 'https://configured.example', 'en');
      expect(first?.html).toContain('Cached');
      expect((await owner.patch(cms(orgId, `/pages/${encodeURIComponent(id)}`), { title: 'Renamed live' })).status).toBe(200);
      const second = await prerenderPageCached(orgId, slug, 'https://configured.example', 'en');
      expect(second?.html).toBe(first?.html); // served from the memo, by design (TTL invalidation)
    } finally {
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
    }
  });

  it("a `$'` in a post title does not splice the body into the heading", async () => {
    const { owner, orgId } = await ownerWithEditor();
    const r = await owner.post(cms(orgId, '/pages'), { title: "Price $' list", kind: 'post', sections: [{ type: 'richText', data: { heading: 'H', text: 'UNIQUE-BODY-MARKER' } }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await owner.post(cms(orgId, `/pages/${encodeURIComponent(r.body.pageId)}/publish`))).status).toBe(200);
    const out = await prerenderPageCached(orgId, r.body.slug, 'https://good.example', 'en');
    // The heading is exactly the escaped title. With a string replacement, `$'`
    // expanded to "everything after the match" — the whole body, inside <h1>.
    const h1 = /<header>\n<h1>([\s\S]*?)<\/h1>/.exec(out?.html ?? '')?.[1];
    expect(h1).toBe('Price $&#39; list');
  });
});
