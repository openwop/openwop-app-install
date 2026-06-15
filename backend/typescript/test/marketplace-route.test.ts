/**
 * Marketplace (ADR 0022) — ROUTE + service harness. Boots the real app and drives:
 * the listing browse projection, the install gate (toggle + SUPERADMIN, delegating
 * to registryInstaller — mocked), review CRUD (RBAC, upsert-not-duplicate, aggregate),
 * cross-tenant/cross-org IDOR + author-only delete, toggle-off 404 (backend
 * authority), the ctx.features.marketplace surface (read-only, install excluded) +
 * the search node, and the well-known advertisement.
 */

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the install delegate so the test never hits a live registry — we assert the
// route DELEGATES to it (the ADR's headline boundary) past the superadmin gate.
// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs.
const { installSpy } = vi.hoisted(() => ({ installSpy: vi.fn(async (_target: { name: string; version: string }, _opts: unknown) => ({ installed: true as const })) }));
vi.mock('../src/packs/registryInstaller.js', async (orig) => {
  const real = await orig<typeof import('../src/packs/registryInstaller.js')>();
  return { ...real, installPackFromRegistry: installSpy };
});

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  upsertReview, listReviews, ratingSummary, deleteReview, __resetMarketplaceReviews,
} from '../src/features/marketplace/reviewService.js';
import { buildMarketplaceSurface } from '../src/features/marketplace/surface.js';

const PORT = 18913;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN; // keep the superadmin gate honest
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  for (const id of ['users', 'marketplace']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string, hdr?: Record<string, string>) => call('GET', p, undefined, hdr),
    post: (p: string, b?: unknown, hdr?: Record<string, string>) => call('POST', p, b, hdr),
    del: (p: string, hdr?: Record<string, string>) => call('DELETE', p, undefined, hdr),
  };
}
const pub = client();
let n = 0;
/** An owner in a deterministic tenant with an org (workspace:write by ownership). */
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const tenantId = `t-mkt-${n++}`;
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: `mkt-${n}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enable = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('marketplace'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Marketplace: registration + advertisement', () => {
  it('is registered + advertises ctx.features.marketplace', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'marketplace')).toBe(true);
    expect((await pub.get('/.well-known/openwop')).body.hostExtensions?.featureSurfaces).toContain('host.sample.marketplace');
  });
});

describe('Marketplace: browse listings (toggle-gated)', () => {
  it('an authenticated caller browses; the projection includes the feature packs', async () => {
    const { owner } = await ownerWithOrg();
    const r = await owner.get('/v1/host/openwop-app/marketplace/listings');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.listings)).toBe(true);
    // The mounted feature.marketplace.* packs should appear in the catalog.
    expect(r.body.listings.some((l: { packName: string }) => l.packName.startsWith('feature.'))).toBe(true);
  });

  it('toggle OFF ⇒ 404 (backend authority)', async () => {
    const { owner } = await ownerWithOrg();
    try {
      await enable('off');
      expect((await owner.get('/v1/host/openwop-app/marketplace/listings')).status).toBe(404);
    } finally { await enable('on'); }
  });
});

describe('Marketplace: install (toggle + SUPERADMIN, delegates to registryInstaller)', () => {
  beforeEach(() => installSpy.mockClear());

  it('a non-superadmin org owner is 403 (fail-closed; never reaches the installer)', async () => {
    const { owner } = await ownerWithOrg();
    const r = await owner.post('/v1/host/openwop-app/marketplace/install', { packName: 'feature.crm.nodes', version: '1.0.0' });
    expect(r.status).toBe(403);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('a superadmin (wildcard bearer) reaches + delegates to installPackFromRegistry', async () => {
    // The default `dev-token` API key authenticates as tenants:['*'] → superadmin.
    const r = await pub.post('/v1/host/openwop-app/marketplace/install',
      { packName: 'feature.crm.nodes', version: '1.0.0' },
      { authorization: 'Bearer dev-token' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.installed).toBe(true);
    expect(installSpy).toHaveBeenCalledOnce();
    expect(installSpy.mock.calls[0]?.[0]).toEqual({ name: 'feature.crm.nodes', version: '1.0.0' });
  });

  it('missing packName/version 400s before delegating', async () => {
    const r = await pub.post('/v1/host/openwop-app/marketplace/install', { packName: 'x' }, { authorization: 'Bearer dev-token' });
    expect(r.status).toBe(400);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('install is toggle-gated too (OFF ⇒ 404, before the superadmin check)', async () => {
    try {
      await enable('off');
      const r = await pub.post('/v1/host/openwop-app/marketplace/install', { packName: 'feature.crm.nodes', version: '1.0.0' }, { authorization: 'Bearer dev-token' });
      expect(r.status).toBe(404);
      expect(installSpy).not.toHaveBeenCalled();
    } finally { await enable('on'); }
  });
});

describe('Marketplace: reviews CRUD (RBAC) + IDOR + aggregate', () => {
  const PACK = 'feature.crm.nodes'; // a pack present in the mounted catalog
  const reviewsUrl = (orgId: string) => `/v1/host/openwop-app/marketplace/orgs/${orgId}/listings/${PACK}/reviews`;

  it('owner posts a review, lists it, aggregate reflects it; a re-post UPDATES (no dup)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const c1 = await owner.post(reviewsUrl(orgId), { rating: 4, body: 'Solid pack' });
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    expect(c1.body.rating).toBe(4);

    // Same author re-reviews → upsert (same reviewId, count stays 1).
    const c2 = await owner.post(reviewsUrl(orgId), { rating: 5, body: 'Even better' });
    expect(c2.body.reviewId).toBe(c1.body.reviewId);

    const list = await owner.get(reviewsUrl(orgId));
    expect(list.body.reviews).toHaveLength(1);
    expect(list.body.summary.count).toBe(1);
    expect(list.body.summary.average).toBe(5);
  });

  it('rating out of [1,5] or non-integer 400s', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await owner.post(reviewsUrl(orgId), { rating: 0 })).status).toBe(400);
    expect((await owner.post(reviewsUrl(orgId), { rating: 6 })).status).toBe(400);
    expect((await owner.post(reviewsUrl(orgId), { rating: 3.5 })).status).toBe(400);
    expect((await owner.post(reviewsUrl(orgId), {})).status).toBe(400);
  });

  it('reviewing a phantom pack 404s', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(`/v1/host/openwop-app/marketplace/orgs/${orgId}/listings/no.such.pack/reviews`, { rating: 5 });
    expect(r.status).toBe(404);
  });

  it('cross-tenant access 404s (IDOR — org not in caller’s tenant)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    expect((await b.owner.get(reviewsUrl(a.orgId))).status).toBe(404);
    expect((await b.owner.post(reviewsUrl(a.orgId), { rating: 5 })).status).toBe(404);
  });

  it('author can delete own review; aggregate empties', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const c = await owner.post(reviewsUrl(orgId), { rating: 3 });
    expect((await owner.del(`${reviewsUrl(orgId)}/${c.body.reviewId}`)).status).toBe(204);
    const list = await owner.get(reviewsUrl(orgId));
    expect(list.body.reviews).toHaveLength(0);
    expect(list.body.summary.average).toBeNull();
  });

  it('toggle OFF ⇒ reviews 404 (backend authority)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    try {
      await enable('off');
      expect((await owner.get(reviewsUrl(orgId))).status).toBe(404);
      expect((await owner.post(reviewsUrl(orgId), { rating: 5 })).status).toBe(404);
    } finally { await enable('on'); }
  });
});

describe('Marketplace: reviewService unit (tenant+org isolation, upsert, delete-guard)', () => {
  beforeEach(async () => { await __resetMarketplaceReviews(); });

  it('upsert is one-per-(tenant,org,pack,author); aggregate computed on read', async () => {
    await upsertReview({ tenantId: 't1', orgId: 'o1', packName: 'p', rating: 4, authorId: 'A' });
    await upsertReview({ tenantId: 't1', orgId: 'o1', packName: 'p', rating: 2, authorId: 'A' }); // same author → update
    await upsertReview({ tenantId: 't1', orgId: 'o1', packName: 'p', rating: 5, authorId: 'B' });
    const reviews = await listReviews('t1', 'o1', 'p');
    expect(reviews).toHaveLength(2); // A (updated) + B
    const summary = await ratingSummary('t1', 'o1', 'p');
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(3.5); // (2 + 5) / 2
  });

  it('cross-tenant + cross-org reads are isolated (CTI-1)', async () => {
    await upsertReview({ tenantId: 't1', orgId: 'o1', packName: 'p', rating: 5, authorId: 'A' });
    expect(await listReviews('t2', 'o1', 'p')).toHaveLength(0); // other tenant
    expect(await listReviews('t1', 'o2', 'p')).toHaveLength(0); // other org
  });

  it('delete is author/admin guarded + IDOR-scoped', async () => {
    const r = await upsertReview({ tenantId: 't1', orgId: 'o1', packName: 'p', rating: 4, authorId: 'A' });
    // wrong tenant/org → not found (false), no throw
    expect(await deleteReview('t2', 'o1', r.reviewId, { authorId: 'A', isAdmin: false })).toBe(false);
    // non-author non-admin → 403
    await expect(deleteReview('t1', 'o1', r.reviewId, { authorId: 'B', isAdmin: false })).rejects.toThrow(/author or an org admin/);
    // admin may delete another's review
    expect(await deleteReview('t1', 'o1', r.reviewId, { authorId: 'B', isAdmin: true })).toBe(true);
  });
});

describe('Marketplace: ctx.features.marketplace surface (read-only; install excluded)', () => {
  it('listings/search are present; install is NOT a surface method', async () => {
    const surf = buildMarketplaceSurface({ tenantId: 't1', runId: 'run-1' });
    expect(typeof surf.listings).toBe('function');
    expect(typeof surf.search).toBe('function');
    expect((surf as Record<string, unknown>).install).toBeUndefined(); // privileged — never a node-reachable op

    const all = (await surf.listings({})) as { listings: Array<{ packName: string }> };
    expect(Array.isArray(all.listings)).toBe(true);
    const hits = (await surf.search({ query: 'marketplace' })) as { listings: Array<{ packName: string }> };
    expect(hits.listings.every((l) => /marketplace/i.test(`${l.packName}`))).toBe(true);
  });

  it('feature.marketplace.nodes.search runs over a stub ctx.features.marketplace', async () => {
    const mod = await import('../../../packs/feature.marketplace.nodes/index.mjs');
    const surf = buildMarketplaceSurface({ tenantId: 't1', runId: 'run-1' });
    const ctx = (inputs: Record<string, unknown>) => ({ features: { marketplace: surf }, inputs });
    const r = await mod.nodes['feature.marketplace.nodes.search'](ctx({ query: '' }));
    expect(r.status).toBe('success');
    expect(typeof r.outputs?.total).toBe('number');
  });
});
