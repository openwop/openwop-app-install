/**
 * CMS + Page Builder (ADR 0009) — ROUTE-level harness. Boots the real app and
 * drives the org-scoped, RBAC-gated CMS over HTTP: toggle gating, page CRUD +
 * schema-validated sections + slug uniqueness (Phase 1), the editorial workflow
 * + by-slug published read (Phase 2), versioning + slug redirects (Phase 3), and
 * the three-tier RBAC (editor edits/submits, admin approves/publishes, viewer
 * read-only, cross-tenant fail-closed).
 */

import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18675;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res>; snapshot: () => string }
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const sc = getSetCookies(res.headers);
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p), snapshot: () => cookie };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('cms'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
// ADR 0027: CMS is always-on (no `cms` toggle), so this is a no-op kept so the
// many `enableCms('on')` call sites below still read clearly as "ensure CMS on".
const enableCms = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('cms'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  // Co-tenant owner + member: mint each into one shared explicit tenantId.
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('cms — always-on (ADR 0027)', () => {
  it('has no cms toggle in the catalog and serves a member regardless', async () => {
    // ADR 0027: CMS is always-on — no `toggleDefault`; only org-scoped RBAC gates.
    expect(getToggleDefault('cms')).toBeNull();
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(u(orgId, '/pages'))).status).toBe(200);
  });
});

describe('cms — pages + sections + slugs (Phase 1)', () => {
  it('creates a draft, validates sections, sanitizes content, uniques the slug', async () => {
    await enableCms('on');
    const { owner, orgId } = await ownerWithMember('viewer');

    const page = await owner.post(u(orgId, '/pages'), {
      title: 'Launch Day!',
      sections: [
        { type: 'hero', data: { heading: 'Welcome' } },
        { type: 'richText', data: { text: 'hello <script>alert(1)</script> world' } },
        { type: 'cta', data: { label: 'Go', url: 'javascript:alert(1)' } },
      ],
    });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    expect(page.body.status).toBe('draft');
    expect(page.body.slug).toBe('launch-day');
    expect(page.body.sections).toHaveLength(3);
    // richText is PLAIN TEXT, not HTML — the literal `<script>` is stored inert
    // (rendered as text), so there is no sanitizer to bypass and no `html` field.
    expect(page.body.sections[1].data.html).toBeUndefined();
    expect(page.body.sections[1].data.text).toBe('hello <script>alert(1)</script> world');
    expect(page.body.sections[2].data.url).toBe(''); // dangerous scheme dropped

    // A hero without its required heading → 400; an unknown type → 400.
    expect((await owner.post(u(orgId, '/pages'), { title: 'X', sections: [{ type: 'hero', data: {} }] })).status).toBe(400);
    expect((await owner.post(u(orgId, '/pages'), { title: 'X', sections: [{ type: 'bogus', data: {} }] })).status).toBe(400);

    // Same title → slug collision-suffixed.
    const dup = await owner.post(u(orgId, '/pages'), { title: 'Launch Day!' });
    expect(dup.body.slug).toBe('launch-day-2');

    // Patch bumps the version + re-validates sections.
    const patched = await owner.patch(u(orgId, `/pages/${encodeURIComponent(page.body.pageId)}`), { title: 'Renamed', sections: [{ type: 'image', data: { token: 'mref:abc', alt: 'logo' } }] });
    expect(patched.body.title).toBe('Renamed');
    expect(patched.body.version).toBe(2);
    expect(patched.body.sections).toHaveLength(1);
  });
});

describe('cms — editorial workflow + by-slug (Phase 2)', () => {
  it('editor submits, admin approves/publishes; by-slug shows only published; illegal transitions 409', async () => {
    await enableCms('on');
    const { owner, member, orgId } = await ownerWithMember('editor');
    const page = (await owner.post(u(orgId, '/pages'), { title: 'Blog Post' })).body;

    // Draft is invisible by slug.
    expect((await owner.get(u(orgId, '/pages/by-slug/blog-post'))).status).toBe(404);

    // Editor (workspace:write) can submit; CANNOT approve (needs host:members:manage).
    expect((await member.post(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/submit`))).status).toBe(200);
    const deniedApprove = await member.post(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/approve`));
    expect(deniedApprove.status).toBe(403);
    expect(deniedApprove.body.error).toBe('forbidden_scope');

    // Owner (admin tier) approves → published; by-slug now resolves.
    const approved = await owner.post(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/approve`));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('published');
    expect(approved.body.publishedVersion).toBe(approved.body.version);
    const bySlug = await owner.get(u(orgId, '/pages/by-slug/blog-post'));
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.page.pageId).toBe(page.pageId);

    // Illegal transition: submitting a published page → 409.
    expect((await owner.post(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/submit`))).status).toBe(409);

    // Admin direct-publish from draft (bypasses review).
    const draft2 = (await owner.post(u(orgId, '/pages'), { title: 'Quick' })).body;
    expect((await owner.post(u(orgId, `/pages/${encodeURIComponent(draft2.pageId)}/publish`))).body.status).toBe('published');
  });
});

describe('cms — versions + redirects (Phase 3)', () => {
  it('publish snapshots a version; slug change leaves a redirect; restore returns to draft', async () => {
    await enableCms('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const page = (await owner.post(u(orgId, '/pages'), { title: 'Original', sections: [{ type: 'hero', data: { heading: 'V1' } }] })).body;
    await owner.post(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/publish`));

    // A published version was snapshotted.
    const versions = await owner.get(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/versions`));
    expect(versions.body.versions.length).toBeGreaterThanOrEqual(1);
    const versionId = versions.body.versions[0].versionId;

    // Edit content, then change the slug on the published page → redirect recorded.
    await owner.patch(u(orgId, `/pages/${encodeURIComponent(page.pageId)}`), { sections: [{ type: 'hero', data: { heading: 'V2' } }] });
    await owner.patch(u(orgId, `/pages/${encodeURIComponent(page.pageId)}`), { slug: 'renamed' });
    const direct = await owner.get(u(orgId, '/pages/by-slug/renamed'));
    expect(direct.status).toBe(200);
    const redirected = await owner.get(u(orgId, '/pages/by-slug/original'));
    expect(redirected.status).toBe(200);
    expect(redirected.body.redirectedFrom).toBe('original');
    expect(redirected.body.page.slug).toBe('renamed');

    // Restore the first version → page back to draft with the old content.
    const restored = await owner.post(u(orgId, `/pages/${encodeURIComponent(page.pageId)}/restore/${encodeURIComponent(versionId)}`));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.status).toBe('draft');
    expect(restored.body.sections[0].data.heading).toBe('V1');
  });
});

describe('cms — RBAC', () => {
  it('viewer reads but cannot write (403); a cross-tenant non-member is fail-closed (404)', async () => {
    await enableCms('on');
    const { owner, member, orgId } = await ownerWithMember('viewer');
    await owner.post(u(orgId, '/pages'), { title: 'Seed' });
    expect((await member.get(u(orgId, '/pages'))).status).toBe(200);
    const denied = await member.post(u(orgId, '/pages'), { title: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');

    const stranger = client();
    await signup(stranger);
    expect((await stranger.get(u(orgId, '/pages'))).status).toBe(404);
  });
});

describe('cms — followup hardening', () => {
  it('editorial gate: an editor cannot edit a PUBLISHED page (403); admin can; unpublish reopens it', async () => {
    await enableCms('on');
    const { owner, member, orgId } = await ownerWithMember('editor');
    const page = (await owner.post(u(orgId, '/pages'), { title: 'Live' })).body;
    const pid = encodeURIComponent(page.pageId);

    // An editor CAN edit a draft.
    expect((await member.patch(u(orgId, `/pages/${pid}`), { title: 'Draft edit' })).status).toBe(200);

    // Publish it (admin), then the editor can NO LONGER edit live content (403).
    await owner.post(u(orgId, `/pages/${pid}/publish`));
    const denied = await member.patch(u(orgId, `/pages/${pid}`), { sections: [{ type: 'hero', data: { heading: 'sneaky' } }] });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
    // Admin still can (hotfix authority).
    expect((await owner.patch(u(orgId, `/pages/${pid}`), { title: 'Admin hotfix' })).status).toBe(200);

    // Unpublish (admin) returns it to draft so the editor can edit again.
    const unpub = await owner.post(u(orgId, `/pages/${pid}/unpublish`));
    expect(unpub.body.status).toBe('draft');
    expect((await member.patch(u(orgId, `/pages/${pid}`), { title: 'Reopened' })).status).toBe(200);
    // An editor cannot unpublish (admin-only).
    await owner.post(u(orgId, `/pages/${pid}/publish`));
    expect((await member.post(u(orgId, `/pages/${pid}/unpublish`))).status).toBe(403);
  });

  it('archived is not a dead-end: unpublish reopens an archived page', async () => {
    await enableCms('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const page = (await owner.post(u(orgId, '/pages'), { title: 'A' })).body;
    const pid = encodeURIComponent(page.pageId);
    await owner.post(u(orgId, `/pages/${pid}/publish`));
    await owner.post(u(orgId, `/pages/${pid}/archive`));
    expect((await owner.post(u(orgId, `/pages/${pid}/unpublish`))).body.status).toBe('draft');
  });

  it("rejects restoring another page's version (cross-page IDOR → 404)", async () => {
    await enableCms('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const a = (await owner.post(u(orgId, '/pages'), { title: 'A' })).body;
    const b = (await owner.post(u(orgId, '/pages'), { title: 'B' })).body;
    await owner.post(u(orgId, `/pages/${encodeURIComponent(a.pageId)}/publish`));
    await owner.post(u(orgId, `/pages/${encodeURIComponent(b.pageId)}/publish`));
    const bVersion = (await owner.get(u(orgId, `/pages/${encodeURIComponent(b.pageId)}/versions`))).body.versions[0].versionId;
    const cross = await owner.post(u(orgId, `/pages/${encodeURIComponent(a.pageId)}/restore/${encodeURIComponent(bVersion)}`));
    expect(cross.status).toBe(404);
  });

  it('redirects survive a double rename (chain collapse — old slug still resolves)', async () => {
    await enableCms('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const page = (await owner.post(u(orgId, '/pages'), { title: 'Orig', slug: 'orig' })).body;
    const pid = encodeURIComponent(page.pageId);
    await owner.post(u(orgId, `/pages/${pid}/publish`));
    await owner.patch(u(orgId, `/pages/${pid}`), { slug: 'mid' });   // redirect orig→mid
    await owner.patch(u(orgId, `/pages/${pid}`), { slug: 'final' }); // collapse: orig→final, mid→final

    const fromOrig = await owner.get(u(orgId, '/pages/by-slug/orig'));
    expect(fromOrig.status, JSON.stringify(fromOrig.body)).toBe(200);
    expect(fromOrig.body.page.slug).toBe('final'); // one hop, not a broken chain
    const fromMid = await owner.get(u(orgId, '/pages/by-slug/mid'));
    expect(fromMid.body.page.slug).toBe('final');
  });
});
