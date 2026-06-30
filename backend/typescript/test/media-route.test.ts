/**
 * Media library (ADR 0007) — ROUTE-level harness. Boots the real app and drives
 * the org-scoped, RBAC-gated media surface over HTTP: toggle gating, collections
 * + asset upload/serve/search/usage, the re-home-on-collection-delete behavior,
 * and the workspace:read/write authority (owner writes; a viewer member is
 * read-only; a non-member is fail-closed).
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
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  for (const id of ['users', 'media']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
  raw: (p: string) => Promise<{ status: number; contentType: string | null }>;
  snapshot: () => string;
}
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    raw: async (p) => {
      const res = await fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {} });
      return { status: res.status, contentType: res.headers.get('content-type') };
    },
    snapshot: () => cookie,
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('m'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** An owner with an org, plus a second same-tenant user added as a viewer member.
 *  Mint each into one shared explicit tenantId, each in its own client. */
async function ownerWithViewer(): Promise<{ owner: Client; viewer: Client; viewerId: string; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const viewer = client();
  const viewerUser = await signup(viewer, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Viewer', subject: viewerUser.userId, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, viewer, viewerId: viewerUser.userId, orgId };
}
const m = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('media library — always-on (ADR 0027)', () => {
  it('has no media toggle in the catalog and serves regardless', async () => {
    // ADR 0027: Media is always-on — no `toggleDefault`, so it cannot be turned
    // off. A member with workspace:read reads its surface unconditionally.
    expect(getToggleDefault('media')).toBeNull();
    const { owner, orgId } = await ownerWithViewer();
    const r = await owner.get(m(orgId, '/collections'));
    expect(r.status).toBe(200);
  });
});

describe('media library — collections + assets (owner = workspace:write)', () => {
  it('full lifecycle: collection, upload, serve, search, move, usage, delete', async () => {
    const { owner, orgId } = await ownerWithViewer();

    // Collection.
    const col = await owner.post(m(orgId, '/collections'), { name: 'Brand' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const collectionId = col.body.collectionId;
    expect((await owner.get(m(orgId, '/collections'))).body.collections).toHaveLength(1);

    // Upload an asset into the collection.
    const up = await owner.post(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'logo.png', collectionId, tags: ['Logo', 'logo'] });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const assetId = up.body.assetId;
    expect(up.body.sizeBytes).toBeGreaterThan(0);
    expect(up.body.tags).toEqual(['logo']); // deduped + lowercased
    expect(up.body.serveUrl).toContain('/v1/host/openwop-app/assets/');

    // The serve URL streams the bytes (capability token, public).
    const served = await owner.raw(up.body.serveUrl);
    expect(served.status).toBe(200);
    expect(served.contentType).toContain('image/png');

    // Search by tag + by name substring.
    expect((await owner.get(m(orgId, '/assets?tag=logo'))).body.assets).toHaveLength(1);
    expect((await owner.get(m(orgId, '/assets?q=log'))).body.assets).toHaveLength(1);
    expect((await owner.get(m(orgId, '/assets?q=nope'))).body.assets).toHaveLength(0);
    expect((await owner.get(m(orgId, `/assets?collectionId=${encodeURIComponent(collectionId)}`))).body.assets).toHaveLength(1);

    // Rename + retag.
    const patched = await owner.patch(m(orgId, `/assets/${encodeURIComponent(assetId)}`), { name: 'wordmark.png', tags: ['brand'] });
    expect(patched.body.name).toBe('wordmark.png');
    expect(patched.body.tags).toEqual(['brand']);

    // Usage tracking.
    const used = await owner.post(m(orgId, `/assets/${encodeURIComponent(assetId)}/use`));
    expect(used.body.usageCount).toBe(1);
    expect(used.body.lastUsedAt).toBeTruthy();

    // Deleting the collection re-homes the asset to uncategorized (not orphaned).
    const delCol = await owner.del(m(orgId, `/collections/${encodeURIComponent(collectionId)}`));
    expect(delCol.body.deleted.rehomed).toBe(1);
    const afterCol = await owner.get(m(orgId, `/assets/${encodeURIComponent(assetId)}`));
    expect(afterCol.body.collectionId).toBeUndefined();

    // Delete the asset.
    expect((await owner.del(m(orgId, `/assets/${encodeURIComponent(assetId)}`))).status).toBe(204);
    expect((await owner.get(m(orgId, '/assets'))).body.assets).toHaveLength(0);
  });

  it('rejects an upload into a foreign collection (404)', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const up = await owner.post(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'x.png', collectionId: 'mcol:does-not-exist' });
    expect(up.status).toBe(404);
  });
});

describe('media library — RBAC authority', () => {
  it('a viewer member can read but NOT write (403)', async () => {
    const { owner, viewer, orgId } = await ownerWithViewer();
    await owner.post(m(orgId, '/collections'), { name: 'Shared' });

    // Viewer (workspace:read) can list.
    const read = await viewer.get(m(orgId, '/collections'));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.collections).toHaveLength(1);

    // Viewer lacks workspace:write → create/upload denied fail-closed.
    const write = await viewer.post(m(orgId, '/collections'), { name: 'Nope' });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('forbidden_scope');
    const upload = await viewer.post(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'v.png' });
    expect(upload.status).toBe(403);
  });

  it('a non-member (different tenant) is fail-closed (404 — org not in their tenant)', async () => {
    const { orgId } = await ownerWithViewer();
    const stranger = client();
    await signup(stranger); // fresh anon tenant
    const r = await stranger.get(m(orgId, '/collections'));
    expect(r.status).toBe(404);
    const w = await stranger.post(m(orgId, '/collections'), { name: 'x' });
    expect(w.status).toBe(404);
  });
});

describe('media library — followup hardening', () => {
  it('rejects a disallowed contentType (415: text/html, svg) and invalid base64 (400)', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const html = await owner.post(m(orgId, '/assets'), { contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64'), contentType: 'text/html', name: 'x.html' });
    expect(html.status, JSON.stringify(html.body)).toBe(415);
    const svg = await owner.post(m(orgId, '/assets'), { contentBase64: Buffer.from('<svg onload="alert(1)"/>').toString('base64'), contentType: 'image/svg+xml', name: 'x.svg' });
    expect(svg.status).toBe(415);
    const bad = await owner.post(m(orgId, '/assets'), { contentBase64: 'not valid base64 @@@', contentType: 'image/png', name: 'x.png' });
    expect(bad.status).toBe(400);
  });

  it('an EDITOR (non-owner) can write; a same-tenant member of ANOTHER org is denied (403)', async () => {
    // Owner with two orgs in one tenant; Bob is an EDITOR of orgA only.
    const tenantId = `org:test-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const bob = client();
    const bobUser = await signup(bob, { tenantId });
    const orgA = (await owner.post('/v1/host/openwop-app/orgs', { name: 'A' })).body.orgId;
    const orgB = (await owner.post('/v1/host/openwop-app/orgs', { name: 'B' })).body.orgId;
    const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'Bob', subject: bobUser.userId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    // Editor of A (not owner) holds workspace:write → can create in A.
    const write = await bob.post(m(orgA, '/collections'), { name: 'Editorial' });
    expect(write.status, JSON.stringify(write.body)).toBe(201);

    // Bob is NOT a member of orgB (same tenant) → per-org authority fails closed.
    const crossRead = await bob.get(m(orgB, '/collections'));
    expect(crossRead.status).toBe(403);
    expect(crossRead.body.error).toBe('forbidden_scope');
    const crossWrite = await bob.post(m(orgB, '/collections'), { name: 'x' });
    expect(crossWrite.status).toBe(403);
  });

  it('uncategorized filter is applied server-side (?collectionId=none)', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const col = (await owner.post(m(orgId, '/collections'), { name: 'C' })).body.collectionId;
    await owner.post(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'in.png', collectionId: col });
    await owner.post(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'out.png' });
    const uncat = await owner.get(m(orgId, '/assets?collectionId=none'));
    expect(uncat.body.assets).toHaveLength(1);
    expect(uncat.body.assets[0].name).toBe('out.png');
  });
});
