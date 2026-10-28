/**
 * ADR 0945 P1 — composite mode end to end through a REAL run, with the mock
 * image provider (no spend), and the replay-fork witness for the reclassified
 * generation nodes.
 *
 *  - `compose-product-shot` cuts out the catalog photo (recorded edit call),
 *    composes it on a scene, and the stored result is a `composite` asset whose
 *    product layer IS the cut-out's bytes and whose verdict is `pass`;
 *  - its outputs carry ids only — no serve token, no bytes;
 *  - a replay `:fork` serves the recorded output: no second render, no second
 *    asset, the SAME mediaAssetId (G5 — it used to re-dispatch and pay again);
 *  - the reclassified `render` node is served on a fork the same way;
 *  - with the sub-toggle OFF the node fails closed;
 *  - a cut-out that is NOT this product's photo is refused
 *    `product_depiction_ungrounded`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Resvg } from '@resvg/resvg-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { createProduct, updateProduct } from '../src/features/commerce/commerceService.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { listRenders } from '../src/features/creative-briefs/render/renderService.js';
import { composeProductShot, checkFidelity } from '../src/features/creative-briefs/fidelityService.js';
import { getAsset, listAssets } from '../src/features/media/mediaService.js';
import { getVerdict } from '../src/host/creativeFidelity/index.js';
import { OpenwopError } from '../src/types.js';
import { getSetCookies } from './headerCookies.js';
import { bareRunId } from './support/bareRunId.js';

const png = (svg: string): string => Buffer.from(new Resvg(svg).render().asPng()).toString('base64');
const MUG = png('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="30" y="20" width="120" height="160" fill="#c62828"/></svg>');
const OTHER = png('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="#1565c0"/></svg>');
const SCENE = png('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2e7d32"/></svg>');

let server: http.Server;
let BASE = '';
let cookie = '';
interface Ev { type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown>; error?: { code?: string } } }
interface Body { runId?: string; status?: string; error?: unknown; orgId?: string; assetId?: string; events?: Ev[] }
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
};
const settle = async (runId: string): Promise<{ status: string; error: unknown }> => {
  let snap: Body = {};
  await vi.waitFor(async () => {
    snap = (await call('GET', `/runs/${runId}`)).body ?? snap;
    expect(['completed', 'failed', 'cancelled']).toContain(snap.status ?? '');
  }, { timeout: 15_000, interval: 50 });
  return { status: snap.status ?? '', error: snap.error };
};
const completed = async (runId: string): Promise<void> => { const s = await settle(runId); expect(s.status, JSON.stringify(s.error)).toBe('completed'); };
const nodeDone = async (runId: string, nodeId: string): Promise<Ev | undefined> =>
  ((await call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`)).body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === nodeId);

const TENANT = `org:g945p1-${Date.now()}`;
let orgId = '';
let productId = '';
let briefId = '';
let backgroundAssetId = '';
let otherAssetId = '';
let otherToken = '';
let firstShot: { mediaAssetId: string; verdictId: string } | null = null;

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['commerce', 'creative-briefs', 'creative-briefs.product-grounded']) await setToggle(id, 'on');
  expect((await call('POST', '/host/openwop-app/test/login', { email: 'g945p1@acme.test', tenantId: TENANT })).status).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
  orgId = org.body.orgId as string;
  const up = async (b64: string, name: string): Promise<{ assetId: string; serveUrl: string }> => {
    const r = await call('POST', `/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}/assets`, { contentBase64: b64, contentType: 'image/png', name });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as unknown as { assetId: string; serveUrl: string };
  };
  const mug = await up(MUG, 'mug.png');
  backgroundAssetId = (await up(SCENE, 'scene.png')).assetId;
  const other = await up(OTHER, 'other.png');
  otherAssetId = other.assetId;
  const tokenOf = (serveUrl: string): string => serveUrl.split('/').pop()!;
  otherToken = tokenOf(other.serveUrl);
  productId = (await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Mug', price: 12, imageAssetTokens: [tokenOf(mug.serveUrl)] })).productId;
  briefId = (await createBrief(TENANT, orgId, 'u', { title: 'Mug launch', assetType: 'image', sceneDescription: 'Kitchen.' })).briefId;
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('classification', () => {
  it('the new nodes and the G5 generation nodes are side-effect and served on a fork', () => {
    for (const id of [
      'feature.creative-briefs.nodes.compose-product-shot', 'feature.creative-briefs.nodes.fidelity-check',
      'feature.creative-briefs.nodes.render', 'feature.creative-briefs.nodes.render-variants', 'feature.creative-briefs.nodes.generate-reel',
      'feature.creative-video.nodes.generate', 'feature.creative-video.nodes.text-to-video', 'feature.campaign-channels.nodes.render-concepts',
    ]) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), id).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), id).toBe(true);
    }
  });
});

describe('compose-product-shot through a run', () => {
  it('composes a passing composite from the product photo; a replay fork serves it without a second render', async () => {
    const workflowId = `g945p1.compose.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'n1', typeId: 'feature.creative-briefs.nodes.compose-product-shot', inputs: { orgId, productId, briefId, templateId: 'meta.feed.1x1', backgroundAssetId, editProvider: 'mock' } }], edges: [] });
    const run = await call('POST', '/runs', { workflowId, inputs: {} });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const runId = run.body.runId as string;
    await completed(runId);

    const done = await nodeDone(runId, 'n1');
    const out = done?.payload?.outputs ?? {};
    expect(out.outcome).toBe('pass');
    firstShot = { mediaAssetId: String(out.mediaAssetId), verdictId: String(out.verdictId) };
    // Ids only: no serve path, no token, no bytes anywhere in the recorded output.
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/\/assets\/[A-Za-z0-9_-]{8,}|serveToken|serveUrl|contentBase64/);

    const asset = await getAsset(TENANT, orgId, String(out.mediaAssetId));
    const g = asset?.lineage?.grounding;
    expect(g?.mode).toBe('composite');
    expect(g?.productId).toBe(productId);
    expect(g?.fidelity).toMatchObject({ verdictId: out.verdictId, outcome: 'pass' });
    const verdict = await getVerdict(TENANT, orgId, String(out.verdictId));
    expect(verdict?.checks.find((c) => c.id === 'byte_identity')?.status).toBe('pass');
    expect(verdict?.checks.find((c) => c.id === 'source_product')?.status).toBe('pass');
    // The cut-out records the product photo it came from, by hash.
    const cut = await getAsset(TENANT, orgId, String(out.cutoutAssetId));
    expect(cut?.lineage?.grounding).toMatchObject({ mode: 'edit', op: 'background-remove' });

    const rendersBefore = (await listRenders(TENANT, orgId, briefId)).length;
    const assetsBefore = (await listAssets(TENANT, orgId)).length;
    const fork = await call('POST', `/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkId = fork.body.runId as string;
    await completed(forkId);
    expect((await listRenders(TENANT, orgId, briefId)).length, 'the fork rendered again').toBe(rendersBefore);
    expect((await listAssets(TENANT, orgId)).length, 'the fork minted assets').toBe(assetsBefore);
    expect((await nodeDone(forkId, 'n1'))?.payload?.outputs?.mediaAssetId).toBe(out.mediaAssetId);
  }, 60_000);

  it('the reclassified render node is served on a fork too', async () => {
    const workflowId = `g945p1.render.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'r1', typeId: 'feature.creative-briefs.nodes.render', inputs: { orgId, briefId, templateId: 'meta.feed.1x1', copy: { cta: 'Fork me' }, layers: { background: backgroundAssetId } } }], edges: [] });
    const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
    await completed(runId);
    const before = (await listRenders(TENANT, orgId, briefId)).length;
    const forkId = (await call('POST', `/runs/${runId}:fork`, { mode: 'replay' })).body.runId as string;
    await completed(forkId);
    expect((await listRenders(TENANT, orgId, briefId)).length).toBe(before);
    expect((await nodeDone(forkId, 'r1'))?.payload?.outputs?.mediaAssetId).toBe((await nodeDone(runId, 'r1'))?.payload?.outputs?.mediaAssetId);
  }, 60_000);

  it('a cut-out that is not this product\'s photo is refused', async () => {
    const err = await composeProductShot(TENANT, orgId, 'u', { productId, briefId, templateId: 'meta.feed.1x1', cutoutAssetId: otherAssetId, backgroundAssetId }).catch((e: unknown) => e);
    expect((err as OpenwopError).code).toBe('product_depiction_ungrounded');
  });

  it('with the sub-toggle OFF the node fails closed', async () => {
    await setToggle('creative-briefs.product-grounded', 'off');
    try {
      const workflowId = `g945p1.off.${Date.now()}`;
      registerWorkflow({ workflowId, nodes: [{ nodeId: 'n1', typeId: 'feature.creative-briefs.nodes.fidelity-check', inputs: { orgId, assetId: backgroundAssetId } }], edges: [] });
      const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
      const s = await settle(runId);
      expect(s.status).toBe('failed');
      expect(JSON.stringify(s.error)).toMatch(/not enabled|not_found/);
    } finally {
      await setToggle('creative-briefs.product-grounded', 'on');
    }
  }, 30_000);

  it('a re-check after the product photo changed is a NEW verdict that fails — never the old pass', async () => {
    expect(firstShot).not.toBeNull();
    await updateProduct(TENANT, orgId, productId, { imageAssetTokens: [otherToken] }, { actor: 'test' });
    const v = await checkFidelity(TENANT, orgId, firstShot!.mediaAssetId);
    expect(v.outcome).toBe('fail');
    expect(v.verdictId).not.toBe(firstShot!.verdictId);
    expect(v.checks.find((c) => c.id === 'source_product')?.status).toBe('fail');
    expect((await getAsset(TENANT, orgId, firstShot!.mediaAssetId))?.lineage?.grounding?.fidelity).toMatchObject({ verdictId: v.verdictId, outcome: 'fail' });
  });
});
