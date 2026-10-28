/**
 * ADR 0945 P2 — EDIT mode end to end through a REAL run (mock image provider,
 * scripted vision judge). The P1 header below describes the shared harness.
 *
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
import type { DescribedHeadlessDispatch } from '../src/host/headlessAi.js';

let judgeImpl: DescribedHeadlessDispatch | null = null;
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/headlessAi.js')>()),
  resolveHeadlessAiDescribed: async () => judgeImpl,
}));
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle, storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { createHash } from 'node:crypto';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { setGroundingSettings } from '../src/features/creative-briefs/groundingSettings.js';
import { getAsset, listAssets } from '../src/features/media/mediaService.js';
import { getVerdict, FIDELITY_ATTRIBUTES } from '../src/host/creativeFidelity/index.js';
import { getSetCookies } from './headerCookies.js';
import { bareRunId } from './support/bareRunId.js';

const png = (svg: string): string => Buffer.from(new Resvg(svg).render().asPng()).toString('base64');
const MUG = png('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="30" y="20" width="120" height="160" fill="#c62828"/></svg>');

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

const TENANT = `org:g945p2-${Date.now()}`;
let orgId = '';
let productId = '';
let mugB64 = '';

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
  expect((await call('POST', '/host/openwop-app/test/login', { email: 'g945p2@acme.test', tenantId: TENANT })).status).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
  orgId = org.body.orgId as string;
  const up = async (b64: string, name: string): Promise<{ assetId: string; serveUrl: string }> => {
    const r = await call('POST', `/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}/assets`, { contentBase64: b64, contentType: 'image/png', name });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as unknown as { assetId: string; serveUrl: string };
  };
  mugB64 = MUG;
  const mug = await up(MUG, 'mug.png');
  const tokenOf = (serveUrl: string): string => serveUrl.split('/').pop()!;
  await setGroundingSettings(TENANT, orgId, 'u', { editModeEnabled: true }); // ADR 0945 Q1 — edit mode is per-client opt-in
  productId = (await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Mug', price: 12, imageAssetTokens: [tokenOf(mug.serveUrl)] })).productId;
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const allMatch = (): DescribedHeadlessDispatch => ({ provider: 'anthropic', model: 'scripted', route: 'byok-default', dispatch: async () => JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: 'match', evidence: 'same' })) }) });

describe('edit-product-scene through a run', () => {
  it('edits around the product, judges it, passes; a replay fork serves it (no second edit, no new assets)', async () => {
    judgeImpl = allMatch();
    const workflowId = `g945p2.edit.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'e1', typeId: 'feature.creative-briefs.nodes.edit-product-scene', inputs: { orgId, productId, prompt: 'A sunny kitchen counter.', provider: 'mock' } }], edges: [] });
    const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
    await completed(runId);
    const out = (await nodeDone(runId, 'e1'))?.payload?.outputs ?? {};
    expect(out.outcome).toBe('pass');
    expect(out.repaired).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/\/assets\/[A-Za-z0-9_-]{8,}|serveToken|serveUrl|contentBase64|maskBase64/);
    const asset = await getAsset(TENANT, orgId, String(out.mediaAssetId));
    expect(asset?.lineage?.grounding).toMatchObject({ mode: 'edit', op: 'inpaint', productId });
    const v = await getVerdict(TENANT, orgId, String(out.verdictId));
    expect(v?.judge?.model).toBe('scripted');
    expect(v?.checks.find((c) => c.id === 'aspect')?.status).toBe('pass');

    const before = (await listAssets(TENANT, orgId)).length;
    const forkId = (await call('POST', `/runs/${runId}:fork`, { mode: 'replay' })).body.runId as string;
    judgeImpl = null; // a served fork must not consult the judge at all
    await completed(forkId);
    expect((await listAssets(TENANT, orgId)).length).toBe(before);
    expect((await nodeDone(forkId, 'e1'))?.payload?.outputs?.mediaAssetId).toBe(out.mediaAssetId);
  }, 60_000);

  it('with no vision provider the edit is needs_review, never pass', async () => {
    judgeImpl = null;
    const workflowId = `g945p2.edit-nojudge.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'e1', typeId: 'feature.creative-briefs.nodes.edit-product-scene', inputs: { orgId, productId, prompt: 'A beach at dusk.', provider: 'mock' } }], edges: [] });
    const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
    await completed(runId);
    expect((await nodeDone(runId, 'e1'))?.payload?.outputs?.outcome).toBe('needs_review');
  }, 60_000);

  it('a judge that finds a logo mismatch twice ends the node fidelity_failed after ONE repair', async () => {
    let calls = 0;
    judgeImpl = { provider: 'anthropic', model: 'scripted', route: 'byok-default', dispatch: async () => { calls += 1; return JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: attribute === 'logo' ? 'mismatch' : 'match', evidence: 'x' })) }); } };
    const workflowId = `g945p2.edit-fail.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'e1', typeId: 'feature.creative-briefs.nodes.edit-product-scene', inputs: { orgId, productId, prompt: 'A forest.', provider: 'mock' } }], edges: [] });
    const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
    const s = await settle(runId);
    expect(s.status).toBe('failed');
    expect(JSON.stringify(s.error)).toMatch(/fidelity_failed/);
    expect(calls, 'exactly two judged attempts: the edit and its one repair').toBe(2);
  }, 60_000);

  it('a node\'s productId hint binds only when the catalog confirms the source bytes are that product\'s photo', async () => {
    const media = buildHostSurfaceBundle({ tenantId: TENANT, runId: 'run-hint' }).features.media as Record<string, (a: Record<string, unknown>) => Promise<Record<string, unknown>>>;
    const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
    const honest = await storeMediaAsset(TENANT, { contentBase64: png('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#123456"/></svg>'), contentType: 'image/png', aiOrigin: { provider: 'mock', op: 'background-remove', runId: 'run-hint', nodeId: 'n', inputSha256: sha(mugB64) } });
    const a = await media.createAssetFromServeUrl!({ orgId, url: honest.url, productId });
    expect((await getAsset(TENANT, orgId, String(a.assetId)))?.lineage?.grounding?.productId).toBe(productId);
    const forged = await storeMediaAsset(TENANT, { contentBase64: png('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#654321"/></svg>'), contentType: 'image/png', aiOrigin: { provider: 'mock', op: 'background-remove', runId: 'run-hint', nodeId: 'n', inputSha256: 'f'.repeat(64) } });
    const b = await media.createAssetFromServeUrl!({ orgId, url: forged.url, productId });
    expect((await getAsset(TENANT, orgId, String(b.assetId)))?.lineage?.grounding?.productId, 'an unverified hint is not stamped').toBeUndefined();
  });
});
