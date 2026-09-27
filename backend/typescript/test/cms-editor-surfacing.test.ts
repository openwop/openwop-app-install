/**
 * ADR 0206 — CMS editor surfacing (gap-analysis Phase B), ROUTE-level harness:
 *   B1 snapshot-on-submit + distinct-content dedupe (submit→publish of
 *      unchanged content yields ONE capture; edit→resubmit yields a new one);
 *   B3 page tags (cleaned via the shared tag cleaner) + `?q=&tag=&status=`
 *      list filters (narrow-only — scoping unchanged);
 *   B4 media usage references (media owns `media:usage`; the CMS save/delete
 *      path reconciles; asset-detail "used by" + IDOR).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

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

interface Res<T = any> { status: number; headers: Headers; body: T }
interface Client {
  get: (p: string, headers?: Record<string, string>) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: out };
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
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `surf-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;
const m = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${suffix}`;

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
    const tagged = await owner.get(u(orgId, '/pages?tag=q3'));
    expect(tagged.body.pages.map((p: any) => p.title)).toEqual(['Landing']);
    // q matches title substring, case-insensitive
    const q = await owner.get(u(orgId, '/pages?q=pric'));
    expect(q.body.pages.map((p: any) => p.title)).toEqual(['Pricing']);
    // status filter
    await owner.post(u(orgId, `/pages/${a.body.pageId}/publish`));
    const published = await owner.get(u(orgId, '/pages?status=published'));
    expect(published.body.pages.map((p: any) => p.title)).toEqual(['Landing']);
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
    const pageId = created.body.pageId as string;

    // Submit captures the submitted content.
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    let versions = (await owner.get(u(orgId, `/pages/${pageId}/versions`))).body.versions;
    expect(versions).toHaveLength(1);

    // Approve→publish of the SAME content does not duplicate the capture.
    await owner.post(u(orgId, `/pages/${pageId}/approve`));
    versions = (await owner.get(u(orgId, `/pages/${pageId}/versions`))).body.versions;
    expect(versions).toHaveLength(1);

    // Edit (unpublish → draft → change → submit) captures a NEW version.
    await owner.post(u(orgId, `/pages/${pageId}/unpublish`));
    await owner.patch(u(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'v2' } }] });
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    versions = (await owner.get(u(orgId, `/pages/${pageId}/versions`))).body.versions;
    expect(versions).toHaveLength(2);
    expect(versions[0].snapshot.sections[0].data.heading).toBe('v2'); // newest first

    // Re-submitting unchanged content (reject → submit, no edit) does not duplicate.
    await owner.post(u(orgId, `/pages/${pageId}/reject`));
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    versions = (await owner.get(u(orgId, `/pages/${pageId}/versions`))).body.versions;
    expect(versions).toHaveLength(2);
  });
});

describe('B4 — media usage references', () => {
  it('reconciles "used by" on save, restore, and delete; IDOR-guards the usage read', async () => {
    const { owner, orgId } = await ownerOrg();
    const up = await owner.post(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'hero.png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const assetId = up.body.assetId as string;
    const token = up.body.serveToken as string;

    // Referencing the asset from a page records a usage row.
    const page = await owner.post(u(orgId, '/pages'), {
      title: 'Home',
      sections: [{ type: 'image', data: { token, alt: 'Hero' } }],
    });
    expect(page.status).toBe(201);
    let usage = await owner.get(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.status).toBe(200);
    expect(usage.body.usage).toHaveLength(1);
    expect(usage.body.usage[0]).toMatchObject({ refKind: 'cms-page', refId: page.body.pageId, refLabel: 'Home' });

    // Saving again neither duplicates nor double-counts (deterministic key).
    await owner.patch(u(orgId, `/pages/${page.body.pageId}`), { title: 'Homepage' });
    usage = await owner.get(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(1);
    expect(usage.body.usage[0].refLabel).toBe('Homepage'); // label refreshed

    // De-referencing removes the row.
    await owner.patch(u(orgId, `/pages/${page.body.pageId}`), { sections: [{ type: 'richText', data: { text: 'no image' } }] });
    usage = await owner.get(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(0);

    // Re-reference via a LOCALE OVERLAY (locale image variants count too). The
    // base carries an unknown placeholder token (ignored by the reconcile).
    await owner.patch(u(orgId, `/pages/${page.body.pageId}`), {
      sections: [{ type: 'image', data: { token: 'placeholder-token', alt: 'x' }, localizations: { 'pt-BR': { token } } }],
    });
    usage = await owner.get(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(1);

    // Deleting the page clears its rows.
    await owner.del(u(orgId, `/pages/${page.body.pageId}`));
    usage = await owner.get(m(orgId, `/assets/${assetId}/usage`));
    expect(usage.body.usage).toHaveLength(0);

    // IDOR: a foreign tenant cannot read the asset's usage (uniform 404).
    const { owner: stranger, orgId: strangerOrg } = await ownerOrg();
    expect((await stranger.get(m(strangerOrg, `/assets/${assetId}/usage`))).status).toBe(404);
  });
});
