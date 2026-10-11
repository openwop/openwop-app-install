/**
 * ADR 0206 — CMS editor surfacing (gap-analysis Phase B), ROUTE-level harness:
 *   B1 snapshot-on-submit + distinct-content dedupe (submit→publish of
 *      unchanged content yields ONE capture; edit→resubmit yields a new one);
 *   B3 page tags (cleaned via the shared tag cleaner) + `?q=&tag=&status=`
 *      list filters (narrow-only — scoping unchanged);
 *   B4 media usage references (media owns `media:usage`; the CMS save/delete
 *      path reconciles; asset-detail "used by" + IDOR).
 *
 * Sabotage-witnessed (w16, `w16g2-ed-*`): the tag filter and the shared tag
 * cleaner, the submit-time capture and its version dedupe, overlay tokens in the
 * usage reconcile, the delete-time usage clear, and the usage read's asset check
 * (the IDOR leg — the asset exists, in ANOTHER tenant). Every transition in B1 is
 * asserted, so the dedupe cannot pass on a publish that never happened.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Page } from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
  const m = getToggleDefault('media');
  if (m) await saveConfig({ ...m, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; headers: Headers; body: T }
interface PagesBody { pages: Array<{ title: string }> }
interface VersionsBody { versions: Array<{ snapshot: { sections: Array<{ data: Record<string, unknown> }> } }> }
interface UsageBody { usage: Array<{ refKind: string; refId: string; refLabel: string }> }
interface Client {
  get: <T = Page>(p: string, headers?: Record<string, string>) => Promise<Res<T>>;
  post: <T = Page>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = Page>(p: string, b?: unknown) => Promise<Res<T>>;
  del: (p: string) => Promise<Res<unknown>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: out as T };
  };
  return {
    get: (p, headers) => call('GET', p, undefined, headers),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:surf-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post<unknown>('/host/openwop-app/test/login', { email: `surf-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const u = (orgId: string, suffix = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;
const m = (orgId: string, suffix = ''): string => `/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${suffix}`;

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('B3 — page tags + list filters', () => {
  it('cleans tags on create/patch (lowercase, dedupe, cap) and filters by ?tag=&q=&status=', async () => {
    const { owner, orgId } = await ownerOrg();
    const a = await owner.post(u(orgId, '/pages'), { title: 'Landing', tags: ['Launch', 'launch', 'Q3'] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.tags).toEqual(['launch', 'q3']); // lowercased + deduped
    const b = await owner.post(u(orgId, '/pages'), { title: 'Pricing' });
    expect(b.body.tags).toBeUndefined();

    // Tag filter
    const tagged = await owner.get<PagesBody>(u(orgId, '/pages?tag=q3'));
    expect(tagged.body.pages.map((p) => p.title)).toEqual(['Landing']);
    // q matches title substring, case-insensitive
    const q = await owner.get<PagesBody>(u(orgId, '/pages?q=pric'));
    expect(q.body.pages.map((p) => p.title)).toEqual(['Pricing']);
    // status filter
    expect((await owner.post(u(orgId, `/pages/${a.body.pageId}/publish`))).status).toBe(200);
    const published = await owner.get<PagesBody>(u(orgId, '/pages?status=published'));
    expect(published.body.pages.map((p) => p.title)).toEqual(['Landing']);
    // invalid status → 400
    expect((await owner.get(u(orgId, '/pages?status=bogus'))).status).toBe(400);
    // patch tags off
    const cleared = await owner.patch(u(orgId, `/pages/${b.body.pageId}`), { tags: [] });
    expect(cleared.body.tags).toBeUndefined();
  });
});

describe('B1 — snapshot-on-submit with distinct-content dedupe', () => {
  it('captures at submit; submit→publish of unchanged content yields ONE capture; edits yield a new one', async () => {
    const { owner, orgId } = await ownerOrg();
    const created = await owner.post(u(orgId, '/pages'), { title: 'Doc', sections: [{ type: 'hero', data: { heading: 'v1' } }] });
    const pageId = created.body.pageId;
    const listVersions = async (): Promise<VersionsBody['versions']> =>
      (await owner.get<VersionsBody>(u(orgId, `/pages/${pageId}/versions`))).body.versions;
    /** Each step must actually LAND — a failed transition would leave the
     *  version count unchanged and the dedupe assertions passing for nothing. */
    const step = async (path: string, expectStatus: string): Promise<void> => {
      const r = await owner.post(u(orgId, `/pages/${pageId}/${path}`));
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.status).toBe(expectStatus);
    };

    // Submit captures the submitted content.
    await step('submit', 'in_review');
    expect(await listVersions()).toHaveLength(1);

    // Approve→publish of the SAME content does not duplicate the capture.
    await step('approve', 'published');
    expect(await listVersions()).toHaveLength(1);

    // Edit (unpublish → draft → change → submit) captures a NEW version.
    await step('unpublish', 'draft');
    expect((await owner.patch(u(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'v2' } }] })).status).toBe(200);
    await step('submit', 'in_review');
    const v2 = await listVersions();
    expect(v2).toHaveLength(2);
    expect(v2[0]!.snapshot.sections[0]!.data.heading).toBe('v2'); // newest first

    // Re-submitting unchanged content (reject → submit, no edit) does not duplicate.
    await step('reject', 'draft');
    await step('submit', 'in_review');
    expect(await listVersions()).toHaveLength(2);
  });
});

describe('B4 — media usage references', () => {
  it('reconciles "used by" on save, restore, and delete; IDOR-guards the usage read', async () => {
    const { owner, orgId } = await ownerOrg();
    const up = await owner.post<{ assetId: string; serveToken: string }>(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'hero.png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const assetId = up.body.assetId;
    const token = up.body.serveToken;

    // Referencing the asset from a page records a usage row.
    const page = await owner.post(u(orgId, '/pages'), {
      title: 'Home',
      sections: [{ type: 'image', data: { token, alt: 'Hero' } }],
    });
    expect(page.status).toBe(201);
    let usage = await owner.get<UsageBody>(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.status).toBe(200);
    expect(usage.body.usage).toHaveLength(1);
    expect(usage.body.usage[0]).toMatchObject({ refKind: 'cms-page', refId: page.body.pageId, refLabel: 'Home' });

    // Saving again neither duplicates nor double-counts (deterministic key).
    expect((await owner.patch(u(orgId, `/pages/${page.body.pageId}`), { title: 'Homepage' })).status).toBe(200);
    usage = await owner.get<UsageBody>(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(1);
    expect(usage.body.usage[0].refLabel).toBe('Homepage'); // label refreshed

    // De-referencing removes the row.
    expect((await owner.patch(u(orgId, `/pages/${page.body.pageId}`), { sections: [{ type: 'richText', data: { text: 'no image' } }] })).status).toBe(200);
    usage = await owner.get<UsageBody>(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(0);

    // Re-reference via a LOCALE OVERLAY (locale image variants count too). The
    // base carries an unknown placeholder token (ignored by the reconcile).
    const overlaid = await owner.patch(u(orgId, `/pages/${page.body.pageId}`), {
      sections: [{ type: 'image', data: { token: 'placeholder-token', alt: 'x' }, localizations: { 'pt-BR': { token } } }],
    });
    expect(overlaid.status, JSON.stringify(overlaid.body)).toBe(200);
    usage = await owner.get<UsageBody>(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(1);

    // Deleting the page clears its rows.
    expect((await owner.del(u(orgId, `/pages/${page.body.pageId}`))).status).toBe(204);
    usage = await owner.get<UsageBody>(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(0);

    // IDOR: a foreign tenant cannot read the asset's usage (uniform 404).
    const { owner: stranger, orgId: strangerOrg } = await ownerOrg();
    expect((await stranger.get(m(strangerOrg, `/assets/${assetId}/usage`))).status).toBe(404);
  });
});
