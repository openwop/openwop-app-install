/**
 * UXG-1112-14 (ADR 1112, 2026-11-13): the editor's History list no longer ships every
 * snapshot's sections. `GET …/pages/:pageId/versions?summary=1` answers title, slug and
 * who/when without `sections`, and Compare reads one whole version through
 * `GET …/pages/:pageId/versions/:versionId`.
 *
 * Pins: the summary list matches the full list's ids, order and heads, with no sections;
 * the default list still carries sections (an SPA from before the deploy); a marker
 * written before it carried title/slug/publishedBy falls back to its row; the one-version
 * read is tenant, org and page guarded and never serves a promotion baseline; subject
 * erasure reaches the summary too, since `publishedBy` now rides in the index marker.
 *
 * Sabotage, each restored, each red: drop the page check in `getVersion`; return the
 * marker's `title` without the row fallback (`snapshot.title` undefined); serve
 * `?summary=1` from `listVersions`; let `put` write an erased row without refreshing its marker.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createPage, eraseCmsSubject, ERASED_SUBJECT, getPage, transitionPage, updatePage } from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
}
let n = 0;
async function owner(): Promise<{ call: ReturnType<typeof client>; tenantId: string; orgId: string }> {
  const tenantId = `org:a1112s-${Date.now()}-${n++}`;
  const call = client();
  expect((await call('POST', '/host/openwop-app/test/login', { email: `a1112s-${n}@acme.test`, tenantId })).status).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { call, tenantId, orgId: org.body.orgId as string };
}
const path = (orgId: string, pageId: string, s = '') => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/versions${s}`;
const text = (html: string) => [{ sectionId: 'sec:t', type: 'richText', data: { html } }];

async function publishedTwice(tenantId: string, orgId: string): Promise<string> {
  const p = await createPage({ tenantId, orgId, title: 'History', sections: text('<p>v0</p>'), createdBy: 'u-author' });
  for (const i of [1, 2]) {
    if ((await getPage(tenantId, orgId, p.pageId))?.status === 'published') await transitionPage(tenantId, orgId, p.pageId, 'unpublish', 'u-admin');
    await updatePage(tenantId, orgId, p.pageId, { title: `History ${i}`, sections: text(`<p>Edit ${i}</p>`) }, 'u-author');
    await transitionPage(tenantId, orgId, p.pageId, 'publish', 'u-admin');
  }
  return p.pageId;
}

describe('UXG-1112-14 — history summaries and the one-version read', () => {
  it('the summary list is the full list without sections; the default is unchanged', async () => {
    const a = await owner();
    const pageId = await publishedTwice(a.tenantId, a.orgId);
    const full = (await a.call('GET', path(a.orgId, pageId))).body.versions as Json[];
    const sum = await a.call('GET', path(a.orgId, pageId, '?summary=1'));
    expect(sum.status).toBe(200);
    const rows = sum.body.versions as Json[];
    expect(full.length).toBe(2);
    expect(rows.map((v) => v.versionId)).toEqual(full.map((v) => v.versionId));
    rows.forEach((v, i) => {
      const f = full[i]!;
      expect(v.snapshot).toEqual({ title: (f.snapshot as Json).title, slug: (f.snapshot as Json).slug });
      expect([v.publishedBy, v.publishedAt, v.version]).toEqual([f.publishedBy, f.publishedAt, f.version]);
    });
    expect(((full[0]!.snapshot as Json).sections as unknown[]).length).toBeGreaterThan(0);
    expect((rows[0]!.snapshot as Json).title).toBe('History 2');
  });

  it('a marker without the head fields falls back to its row', async () => {
    const a = await owner();
    const pageId = await publishedTwice(a.tenantId, a.orgId);
    // Verified, so the list reads the markers rather than the rows.
    const handle = new DurableCollection<{ versionId: string; tenantId: string }>('cms:pageversion', (v) => v.versionId, undefined, (v) => v.tenantId);
    await handle.reconcileTenantIndex({ windowMs: 0, now: Date.now() - 1 });
    await handle.reconcileTenantIndex({ windowMs: 0, now: Date.now() });
    expect(await handle.tenantIndexVerified()).toBe(true);
    // The first projected read backfills the index once; strip after it.
    await a.call('GET', path(a.orgId, pageId, '?summary=1'));
    const storage = __hostExtStorage()!;
    let stripped = 0;
    for (const m of await storage.kvList(`hostextidx:cms:pageversion:${a.tenantId}:`)) {
      const marker = JSON.parse(m.value) as { id: string; p?: Json };
      if (marker.p?.title) { stripped += 1; delete marker.p.title; delete marker.p.slug; delete marker.p.publishedBy; }
      await storage.kvSet(m.key, JSON.stringify(marker));
    }
    expect(stripped).toBeGreaterThanOrEqual(2);
    const rows = (await a.call('GET', path(a.orgId, pageId, '?summary=1'))).body.versions as Json[];
    expect(rows.map((v) => (v.snapshot as Json).title)).toEqual(['History 2', 'History 1']);
    expect(rows.every((v) => v.publishedBy === 'u-admin' || v.publishedBy === 'u-author')).toBe(true);
  });

  it('the one-version read is guarded by tenant, org and page', async () => {
    const a = await owner();
    const b = await owner();
    const pageId = await publishedTwice(a.tenantId, a.orgId);
    const other = await createPage({ tenantId: a.tenantId, orgId: a.orgId, title: 'Other', sections: text('<p>x</p>'), createdBy: 'u-author' });
    const [newest] = (await a.call('GET', path(a.orgId, pageId, '?summary=1'))).body.versions as Json[];
    const id = encodeURIComponent(newest!.versionId as string);

    const one = await a.call('GET', path(a.orgId, pageId, `/${id}`));
    expect(one.status).toBe(200);
    expect(((one.body.snapshot as Json).sections as unknown[]).length).toBeGreaterThan(0);

    expect((await a.call('GET', path(a.orgId, other.pageId, `/${id}`))).status).toBe(404);
    expect((await b.call('GET', path(b.orgId, pageId, `/${id}`))).status).toBe(404);
    expect((await a.call('GET', path(a.orgId, pageId, '/pver%3Anope'))).status).toBe(404);
  });

  it('erasing the publisher reaches the summary, not only the row', async () => {
    const a = await owner();
    const pageId = await publishedTwice(a.tenantId, a.orgId);
    const handle = new DurableCollection<{ versionId: string; tenantId: string }>('cms:pageversion', (v) => v.versionId, undefined, (v) => v.tenantId);
    await handle.reconcileTenantIndex({ windowMs: 0, now: Date.now() - 1 });
    await handle.reconcileTenantIndex({ windowMs: 0, now: Date.now() });
    const before = (await a.call('GET', path(a.orgId, pageId, '?summary=1'))).body.versions as Json[];
    expect(before.map((v) => v.publishedBy)).toContain('u-admin');
    await eraseCmsSubject(a.tenantId, 'u-admin');
    const after = (await a.call('GET', path(a.orgId, pageId, '?summary=1'))).body.versions as Json[];
    expect(after.length).toBe(before.length);
    expect(after.map((v) => v.publishedBy)).not.toContain('u-admin');
    expect(after.some((v) => v.publishedBy === ERASED_SUBJECT)).toBe(true);
  });
});
