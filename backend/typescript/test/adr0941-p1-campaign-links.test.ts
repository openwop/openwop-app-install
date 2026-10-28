/**
 * ADR 0941 P1 — product refs, goal and the links projection. (Funnels link from
 * the funnel side, `funnel.campaignId`, owned by ADR 0948; the campaign stores none.)
 *
 * Real app, real sign-ins, through the HTTP routes (authz and validation are
 * only observable there). Exit criteria (ADR 0941 § Phased plan, P1):
 *   - a product ref in another org (or none at all) is a 404, before any write;
 *   - deleting a product detaches the ref and flags the campaign
 *     (`attention: product_deleted`), never deleting the campaign;
 *   - `GET …/links` reports a failed read as `failed`, a feature that is off as
 *     `unavailable`, and a deleted record as `missing`, never as "not linked";
 *   - the goal is closed-world validated and its version is the service's;
 *   - concurrent campaign writes never drop each other (every writer is a CAS).
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - the `getProduct` existence check removed from PATCH: "a product ref in
 *     another org…";
 *   - `registerCampaignLinkHooks()` removed from feature.ts: "deleting the product…";
 *   - the per-section try/catch in `section()` removed: "a failed read is reported…";
 *   - `campaigns.compareAndSwap` in `mutateCampaign` replaced by a plain put:
 *     "concurrent writes…";
 *   - the `closed()` unknown-key check removed: "shape errors…" and "the goal is
 *     closed-world…".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const productReads = { fail: false };
vi.mock('../src/features/commerce/commerceService.js', async (orig) => {
  const real = await orig<typeof import('../src/features/commerce/commerceService.js')>();
  return {
    ...real,
    // The links read fails when this flag is set; the PATCH validation path is not exercised while it is.
    getProduct: async (t: string, o: string, id: string) => {
      if (productReads.fail) throw new Error('storage unavailable');
      return real.getProduct(t, o, id);
    },
  };
});

import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { createProduct, deleteProduct } from '../src/features/commerce/commerceService.js';
import { __putCampaignRow, ensureDraftCampaign, getCampaign, renameCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { detachDeletedProduct, setCampaignLinks } from '../src/features/campaign-orchestration/campaignLinks.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let n = 0;

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'commerce']) await setToggle(id, 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The route bodies this suite reads. */
interface Body {
  user: { userId: string };
  orgId: string;
  campaign: { productRefs?: unknown; attention?: Array<{ reason: string; productId: string }>; goal?: { version: number } };
  links: Record<string, { status: string; items?: Array<Record<string, unknown>>; reason?: string; error?: string }>;
}
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Body }; // JSON boundary
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const C = '/host/openwop-app/campaign-orchestration';

async function setup() {
  const tenantId = `org:cl-${Date.now()}-${n++}`;
  const owner = client();
  const userId = (await owner.post('/host/openwop-app/test/login', { email: `cl-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Client A' })).body.orgId;
  const otherOrgId = (await owner.post('/host/openwop-app/orgs', { name: 'Client B' })).body.orgId;
  const brief = await createBrief(tenantId, orgId, userId, { name: `Launch ${n}`, channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  const { campaign } = await ensureDraftCampaign(tenantId, brief, userId);
  const product = await createProduct({ tenantId, orgId, createdBy: userId, type: 'digital', name: 'Course', price: 49 });
  const foreignProduct = await createProduct({ tenantId, orgId: otherOrgId, createdBy: userId, type: 'digital', name: 'Other', price: 9 });
  return { tenantId, orgId, userId, owner, campaign, product, foreignProduct };
}

describe('ADR 0941 P1 — product refs', () => {
  it('a product ref in another org, or a missing one, is a 404 and nothing is written', async () => {
    const s = await setup();
    const foreign = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { productRefs: [{ productId: s.foreignProduct.productId, role: 'primary' }] });
    expect(foreign.status).toBe(404);
    const missing = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { productRefs: [{ productId: 'nope', role: 'primary' }], name: 'Renamed' });
    expect(missing.status).toBe(404);
    const after = await getCampaign(s.tenantId, s.campaign.id);
    expect(after?.productRefs).toBeUndefined();
    expect(after?.name).toBe(s.campaign.name);
    const ok = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { productRefs: [{ productId: s.product.productId, role: 'primary' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.campaign.productRefs).toEqual([{ productId: s.product.productId, role: 'primary' }]);
  });

  it('a clear racing reattachment keeps the reverse marker needed by product deletion', async () => {
    const s = await setup();
    const refs = [{ productId: s.product.productId, role: 'primary' as const }];
    await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: refs });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let reattached = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await cas(...args);
      if (!reattached && result.swapped && args[0].startsWith('hostext:campaign-orchestration:campaign:') && args[0].endsWith(`::${s.campaign.id}`)) {
        reattached = true;
        await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: refs });
      }
      return result;
    });
    try { await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: [] }); }
    finally { spy.mockRestore(); }
    expect(reattached).toBe(true);
    expect((await getCampaign(s.tenantId, s.campaign.id))?.productRefs).toEqual(refs);
    expect(await deleteProduct(s.tenantId, s.orgId, s.product.productId)).toBe(true);
    const after = await getCampaign(s.tenantId, s.campaign.id);
    expect(after?.productRefs).toBeUndefined();
    expect(after?.attention).toEqual([expect.objectContaining({ reason: 'product_deleted', productId: s.product.productId })]);
  });

  it('reconciles a product deleted after validation but before the campaign CAS', async () => {
    const s = await setup();
    const cas = storage.kvCompareAndSwap.bind(storage);
    let deleted = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!deleted && args[0].startsWith('hostext:campaign-orchestration:campaign:') && args[0].endsWith(`::${s.campaign.id}`)) {
        deleted = true;
        expect(await deleteProduct(s.tenantId, s.orgId, s.product.productId)).toBe(true);
      }
      return cas(...args);
    });
    let response: Awaited<ReturnType<typeof s.owner.patch>>;
    try { response = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { productRefs: [{ productId: s.product.productId, role: 'primary' }] }); }
    finally { spy.mockRestore(); }
    expect(deleted).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body.campaign.productRefs).toBeUndefined();
    expect(response.body.campaign.attention).toEqual([expect.objectContaining({ reason: 'product_deleted', productId: s.product.productId })]);
    expect((await getCampaign(s.tenantId, s.campaign.id))?.productRefs).toBeUndefined();
  });

  it('shape errors are typed 400s: two primaries, a duplicate, an unknown key', async () => {
    const s = await setup();
    const p = s.product.productId;
    for (const productRefs of [
      [{ productId: p, role: 'primary' }, { productId: 'x', role: 'primary' }],
      [{ productId: p, role: 'primary' }, { productId: p, role: 'secondary' }],
      [{ productId: p, role: 'primary', price: 1 }],
    ]) {
      expect((await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { productRefs })).status).toBe(400);
    }
  });

  it('deleting the product detaches the ref and flags the campaign; a person clears the flag', async () => {
    const s = await setup();
    expect((await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { productRefs: [{ productId: s.product.productId, role: 'primary' }] })).status).toBe(200);
    expect(await deleteProduct(s.tenantId, s.orgId, s.product.productId)).toBe(true);
    const got = await getCampaign(s.tenantId, s.campaign.id);
    expect(got).not.toBeNull();
    expect(got?.productRefs).toBeUndefined();
    expect(got?.attention).toEqual([expect.objectContaining({ reason: 'product_deleted', productId: s.product.productId })]);
    const cleared = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { attention: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.campaign.attention).toBeUndefined();
    expect((await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { attention: [{ reason: 'x' }] })).status).toBe(400);
  });

  it('the hook ignores a stale reverse-index row (the campaign no longer holds the ref)', async () => {
    const s = await setup();
    await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: [{ productId: s.product.productId, role: 'primary' }] });
    await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: [] });
    expect(await detachDeletedProduct({ tenantId: s.tenantId, orgId: s.orgId, productId: s.product.productId })).toBe(0);
    expect((await getCampaign(s.tenantId, s.campaign.id))?.attention).toBeUndefined();
  });

  it('concurrent writes never drop each other: renames racing the product-delete hook', async () => {
    const s = await setup();
    await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: [{ productId: s.product.productId, role: 'primary' }] });
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => renameCampaign(s.tenantId, s.campaign.id, `Name ${i}`)),
      detachDeletedProduct({ tenantId: s.tenantId, orgId: s.orgId, productId: s.product.productId }),
      ...Array.from({ length: 6 }, (_, i) => renameCampaign(s.tenantId, s.campaign.id, `Late ${i}`)),
    ]);
    const got = await getCampaign(s.tenantId, s.campaign.id);
    expect(got?.attention?.map((a) => a.productId)).toEqual([s.product.productId]);
    expect(got?.productRefs).toBeUndefined();
    expect(got?.name).toMatch(/^(Name|Late) \d$/);
  });
});

describe('ADR 0941 P1 — goal', () => {
  it('the goal is closed-world validated; the version is the service\'s, never the caller\'s', async () => {
    const s = await setup();
    const goal = { outcome: { metric: 'leads', target: 300, by: '2026-12-31' }, mediaBudget: { totalMinor: 200000, currency: 'USD', dailyCapMinor: 50000 }, guardrails: [{ metric: 'cpl', op: '<=', value: 40 }] };
    const ok = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { goal });
    expect(ok.status).toBe(200);
    expect(ok.body.campaign.goal).toEqual({ ...goal, version: 1 });
    for (const bad of [
      { ...goal, version: 7 },
      { outcome: { metric: 'clicks', target: 1 } },
      { outcome: { metric: 'leads', target: -1 } },
      { ...goal, mediaBudget: { totalMinor: 100, currency: 'USD', dailyCapMinor: 101 } },
      { ...goal, mediaBudget: { totalMinor: 1.5, currency: 'USD' } },
      { ...goal, guardrails: [{ metric: 'cpl', op: '<', value: 1 }] },
    ]) {
      expect((await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { goal: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const cleared = await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { goal: null });
    expect(cleared.body.campaign.goal).toBeUndefined();
    expect((await s.owner.patch(`${C}/campaigns/${s.campaign.id}`, { goal })).body.campaign.goal?.version).toBe(2);
  });
});

describe('ADR 0941 P1 — GET …/links', () => {
  it('lists each link through its owner; a deleted record reads as missing', async () => {
    const s = await setup();
    // A legacy/imported orphan exercises the read projection; the current
    // attach path now reconciles missing or foreign products after its CAS.
    await __putCampaignRow({ ...s.campaign, productRefs: [{ productId: s.product.productId, role: 'primary' }, { productId: s.foreignProduct.productId, role: 'secondary' }] });
    const res = await s.owner.get(`${C}/campaigns/${s.campaign.id}/links`);
    expect(res.status).toBe(200);
    expect(res.body.links.products).toEqual({ status: 'ok', items: [
      { productId: s.product.productId, role: 'primary', state: 'linked', name: 'Course' },
      // In another org: the campaign's org cannot see it, so it reads as missing (no leak).
      { productId: s.foreignProduct.productId, role: 'secondary', state: 'missing' },
    ] });
    expect(res.body.links).not.toHaveProperty('funnels'); // the funnel side owns that edge (ADR 0948)
    expect(res.body.links.runs).toEqual({ status: 'ok', items: [] });
    // Product fields beyond display never leave the projection.
    expect(JSON.stringify(res.body.links.products)).not.toContain('price');
  });

  it('a failed read is reported as failed, a feature that is off as unavailable', async () => {
    const s = await setup();
    await setCampaignLinks(s.tenantId, s.campaign.id, { productRefs: [{ productId: s.product.productId, role: 'primary' }] });
    productReads.fail = true;
    try {
      const res = await s.owner.get(`${C}/campaigns/${s.campaign.id}/links`);
      expect(res.body.links.products).toEqual({ status: 'failed', error: 'read_failed' });
      expect(res.body.links.runs.status).toBe('ok'); // one failed section does not fail the rest
    } finally { productReads.fail = false; }
    await setToggle('commerce', 'off');
    try {
      const res = await s.owner.get(`${C}/campaigns/${s.campaign.id}/links`);
      expect(res.body.links.products).toEqual({ status: 'unavailable', reason: 'feature_off' });
    } finally { await setToggle('commerce', 'on'); }
  });

  it('a non-member gets the uniform 404', async () => {
    const s = await setup();
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `x-${n++}@other.test`, tenantId: s.tenantId });
    expect((await stranger.get(`${C}/campaigns/${s.campaign.id}/links`)).status).toBe(404);
  });
});
