/**
 * ADR 0818 — media library access + quota probes (removed member, MIME spoof,
 * per-workspace byte cap, concurrent cap race). Real HTTP, real app.
 *
 * Reds if: `assertOrgScope` stops refusing a missing scope; uploads stop being
 * sniffed (`storableContentType`); the workspace total is summed per org or
 * dropped; `withOrgCapacity` stops serializing check→write per tenant, counts
 * its bound from queue-join, or makes a writer pay a second bound; the run
 * surface stops applying the acting user's org scope (or the personal-root /
 * demo-only `default` shortcuts change).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { buildMediaSurface } from '../src/features/media/surface.js';
import { withOrgCapacity, __setCapacityWaitMs, createAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
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
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  process.env.OPENWOP_MEDIA_TENANT_MAX_BYTES = String(4 * 1024);
  for (const id of ['users', 'media']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_MEDIA_TENANT_MAX_BYTES;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = unknown> { status: number; body: T }
/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface AssetBody extends ErrBody { assetId: string; contentType: string; name: string }
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = ErrBody>(p: string) => Promise<Res<T>>;
  raw: (p: string) => Promise<{ status: number; contentType: string | null }>;
  snapshot: () => string;
}
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
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
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
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
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('m'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** An owner with an org, plus a second same-tenant user added as a member with
 *  `roles` (a viewer by default). Mint each into one shared explicit tenantId,
 *  each in its own client. */
async function ownerWithViewer(roles: string[] = ['viewer']): Promise<{ owner: Client; viewer: Client; viewerId: string; orgId: string; tenantId: string; ownerId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  const ownerUser = await signup(owner, { tenantId });
  const viewer = client();
  const viewerUser = await signup(viewer, { tenantId });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Viewer', subject: viewerUser.userId, roles });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, viewer, viewerId: viewerUser.userId, orgId, tenantId, ownerId: ownerUser.userId };
}
const m = (orgId: string, suffix = ''): string => `/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${suffix}`;


const HTML_AS_PNG = Buffer.from('<!doctype html><script>alert(1)</script>').toString('base64');
const blob = (size: number, seed: number): string => {
  // A valid PNG signature followed by distinct filler, so dedup never merges two.
  const b = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  return b.toString('base64');
};

describe('ADR 0818 — media access + quota probes', () => {
  it('a removed member loses the library (list + read + write)', async () => {
    // An EDITOR, so the write leg is live before removal (a viewer was never allowed to write).
    const { owner, viewer, orgId } = await ownerWithViewer(['editor']);
    const up = await owner.post<AssetBody>(m(orgId, '/assets'), { contentBase64: PNG_1x1, contentType: 'image/png', name: 'a.png' });
    expect(up.status).toBe(201);
    const asset = m(orgId, `/assets/${up.body.assetId}`);
    expect((await viewer.get(m(orgId, '/assets'))).status).toBe(200);
    expect((await viewer.get(asset)).status).toBe(200);
    expect((await viewer.patch(asset, { name: 'renamed.png' })).status).toBe(200);
    const members = await owner.get<{ members: Array<{ memberId: string; displayName?: string }> }>(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`);
    const viewerRow = members.body.members.find((x) => x.displayName === 'Viewer');
    expect(viewerRow, JSON.stringify(members.body)).toBeTruthy();
    const rm = await owner.del(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(viewerRow!.memberId)}`);
    expect([200, 204]).toContain(rm.status);
    // The org exists, so the refusal is the scope check's 403 — not a 404.
    for (const r of [await viewer.get(m(orgId, '/assets')), await viewer.get(asset), await viewer.patch(asset, { name: 'x.png' }), await viewer.del(asset)]) {
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('forbidden_scope');
    }
  });

  it('refuses bytes that do not match a declared image type (polyglot / MIME spoof)', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const r = await owner.post(m(orgId, '/assets'), { contentBase64: HTML_AS_PNG, contentType: 'image/png', name: 'x.png' });
    expect(r.status, JSON.stringify(r.body)).toBe(415);
    expect(r.body.details?.reason).toBe('type_mismatch');
    const bulk = await owner.post<{ results: Array<{ status: string; message?: string }> }>(m(orgId, '/assets/bulk'), { items: [{ contentBase64: HTML_AS_PNG, contentType: 'image/jpeg', name: 'y.jpg' }] });
    expect(bulk.body.results[0]!.status).toBe('error');
    expect(bulk.body.results[0]!.message).toMatch(/not a valid image\/jpeg/);
  });

  it('a mislabelled image is stored as what its bytes are', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const jpeg = Buffer.alloc(64, 7); jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
    const r = await owner.post<AssetBody>(m(orgId, '/assets'), { contentBase64: jpeg.toString('base64'), contentType: 'image/png', name: 'photo.png' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.contentType).toBe('image/jpeg');
  });

  it('the byte cap is per WORKSPACE: a second org does not reset it', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const org2 = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme Two' });
    expect(org2.status).toBe(201);
    expect((await owner.post(m(orgId, '/assets'), { contentBase64: blob(3 * 1024, 1), contentType: 'image/png', name: 'a.png' })).status).toBe(201);
    const second = await owner.post(m(org2.body.orgId, '/assets'), { contentBase64: blob(3 * 1024, 2), contentType: 'image/png', name: 'b.png' });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.details?.scope, 'the WORKSPACE cap refused it, not the per-org one').toBe('workspace');
  });

  it('concurrent uploads cannot race past the cap', async () => {
    const { owner, orgId } = await ownerWithViewer();
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) =>
      owner.post(m(orgId, '/assets'), { contentBase64: blob(1024, 10 + i), contentType: 'image/png', name: `c${i}.png` })));
    // 4 KiB cap, six 1 KiB uploads: exactly four fit. Unserialized, all six landed.
    const created = results.filter((r) => r.status === 201).length;
    expect(created, results.map((r) => r.status).join(',')).toBe(4);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.details?.scope).toBe('workspace');
    }

    // Over HTTP the six requests do not actually overlap on this in-process
    // storage (probe w5g1-0818a-serialize left the leg above green), so drive
    // the gate directly with writes that YIELD between the check and the row —
    // the shape that let six land before ADR 0818 §3.
    const { orgId: org2, tenantId, ownerId } = await ownerWithViewer();
    const raced = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) =>
      withOrgCapacity(tenantId, org2, 1024, async () => {
        const stored = await mediaStorage.put(tenantId, { contentBase64: blob(1024, 40 + i), contentType: 'image/png' });
        await new Promise<void>((r) => setImmediate(r));
        return createAsset({
          tenantId, orgId: org2, name: `r${i}.png`, contentType: 'image/png',
          sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: ownerId,
        });
      })));
    expect(raced.filter((r) => r.status === 'fulfilled').length, 'serialized check→write: exactly four fit').toBe(4);
  });

  it('a run acting for a VIEWER cannot write into the org through the workflow surface', async () => {
    const { viewerId, orgId, tenantId } = await ownerWithViewer();
    const scratch = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png' });
    const viewerSurface = buildMediaSurface({ tenantId, actingUserId: viewerId });
    await expect(viewerSurface.createAssetFromServeUrl!({ orgId, url: scratch.url, name: 'sneak.png' })).rejects.toMatchObject({ httpStatus: 403 });
    // The same call for a run with no acting user (a schedule) stays tenant-trusted.
    const system = buildMediaSurface({ tenantId });
    await expect(system.createAssetFromServeUrl!({ orgId, url: scratch.url, name: 'ok.png' })).resolves.toMatchObject({ name: 'ok.png' });
  });

  it('a personal workspace keeps writing to its root id (one principal, no org row needed)', async () => {
    const tenantId = `user:adr0818-${Date.now()}`;
    const scratch = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png' });
    const surface = buildMediaSurface({ tenantId, actingUserId: 'user:someone' });
    await expect(surface.createAssetFromServeUrl!({ orgId: tenantId, url: scratch.url, name: 'lesson.png' })).resolves.toMatchObject({ name: 'lesson.png' });
  });

  it('the surface: an owner run writes; a made-up org in a personal tenant is a 404; the root id on `default` keeps working in demo mode only (ADR 0830 KBCD-5)', async () => {
    const { orgId, tenantId, ownerId } = await ownerWithViewer();
    const s1 = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png' });
    const asOwner = buildMediaSurface({ tenantId, actingUserId: ownerId });
    await expect(asOwner.createAssetFromServeUrl!({ orgId, url: s1.url, name: 'owner.png' })).resolves.toMatchObject({ name: 'owner.png' });

    const personal = `user:adr0818-made-up-${Date.now()}`;
    const s2 = await storeMediaAsset(personal, { contentBase64: PNG_1x1, contentType: 'image/png' });
    const stranger = buildMediaSurface({ tenantId: personal, actingUserId: 'user:stranger' });
    await expect(stranger.createAssetFromServeUrl!({ orgId: 'org-does-not-exist', url: s2.url, name: 'x.png' })).rejects.toMatchObject({ httpStatus: 404 });

    // ADR 0830 (`KBCD-5`) — the `default` root shortcut holds in DEMO mode only. Outside it,
    // `default` is the SAML tenant every SSO user shares, so its root is a membership
    // question like any other org (the shared `assertRunOrgScope`, KB and media alike).
    const s3 = await storeMediaAsset('default', { contentBase64: PNG_1x1, contentType: 'image/png' });
    const onDefault = buildMediaSurface({ tenantId: 'default', actingUserId: 'user:someone' });
    const prevDemo = process.env.OPENWOP_DEMO_MODE;
    try {
      process.env.OPENWOP_DEMO_MODE = 'true';
      await expect(onDefault.createAssetFromServeUrl!({ orgId: 'default', url: s3.url, name: 'root.png' })).resolves.toMatchObject({ name: 'root.png' });
      delete process.env.OPENWOP_DEMO_MODE;
      await expect(onDefault.createAssetFromServeUrl!({ orgId: 'default', url: s3.url, name: 'root2.png' })).rejects.toMatchObject({ httpStatus: 404 });
    } finally {
      if (prevDemo === undefined) delete process.env.OPENWOP_DEMO_MODE; else process.env.OPENWOP_DEMO_MODE = prevDemo;
    }
  });

  it('capacity writes run one at a time, and a hung write delays only the writer behind it, once', async () => {
    // Fake setTimeout + Date (setImmediate stays real so storage I/O still settles):
    // the bound and the writes' durations are exact, not wall-clock margins.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 10) {
        await vi.advanceTimersByTimeAsync(10);
        await new Promise<void>((r) => setImmediate(r));
      }
    };
    __setCapacityWaitMs(300);
    try {
      const tenant = `user:adr0818-cap-${n++}`;
      let live = 0; let peak = 0; let done = 0;
      const slow = () => withOrgCapacity(tenant, tenant, 1, async () => {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 120));
        live--; done++;
      });
      const four = Promise.all([slow(), slow(), slow(), slow()]);
      await run(1000);
      await four;
      expect(done).toBe(4);
      expect(peak).toBe(1); // 4 × 120 ms with a 300 ms bound: never overlapping

      const t0 = Date.now();
      void withOrgCapacity(tenant, tenant, 1, () => new Promise<never>(() => undefined)); // hangs forever
      let tb = -1; let tc = -1;
      void withOrgCapacity(tenant, tenant, 1, async () => { tb = Date.now() - t0; });
      void withOrgCapacity(tenant, tenant, 1, async () => { tc = Date.now() - t0; });
      await run(700);
      expect(tb).toBeGreaterThanOrEqual(300); // waited one bound for the hung write
      expect(tb).toBeLessThan(320);
      expect(tc - tb).toBeGreaterThanOrEqual(0);
      expect(tc - tb).toBeLessThan(50); // ...and C did not pay a second bound
    } finally {
      __setCapacityWaitMs(30_000);
      vi.useRealTimers();
    }
  });
});
