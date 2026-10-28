/**
 * ADR 0945 Q1 — edit mode is OFF per client org until that client opts in
 * (team-lead decision 2026-10-20, David can override). The edit node is refused
 * `edit_mode_not_enabled`; only an org admin may turn it on; composite mode
 * needs no opt-in. The P2 harness below is reused.
 *
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
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { listAssets } from '../src/features/media/mediaService.js';
import { FIDELITY_ATTRIBUTES } from '../src/host/creativeFidelity/index.js';
import { getSetCookies } from './headerCookies.js';

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
const TENANT = `org:g945q1-${Date.now()}`;
let orgId = '';
let productId = '';

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
  expect((await call('POST', '/host/openwop-app/test/login', { email: 'g945q1@acme.test', tenantId: TENANT })).status).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
  orgId = org.body.orgId as string;
  const up = async (b64: string, name: string): Promise<{ assetId: string; serveUrl: string }> => {
    const r = await call('POST', `/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}/assets`, { contentBase64: b64, contentType: 'image/png', name });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as unknown as { assetId: string; serveUrl: string };
  };
  const mug = await up(MUG, 'mug.png');
  const tokenOf = (serveUrl: string): string => serveUrl.split('/').pop()!;
  productId = (await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Mug', price: 12, imageAssetTokens: [tokenOf(mug.serveUrl)] })).productId;
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const allMatch = (): DescribedHeadlessDispatch => ({ provider: 'anthropic', model: 'scripted', route: 'byok-default', dispatch: async () => JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: 'match', evidence: 'same' })) }) });
const S = (): string => `/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}/grounding-settings`;

describe('edit mode is a per-client opt-in', () => {
  it('is off by default and the edit node is refused edit_mode_not_enabled, before any spend', async () => {
    judgeImpl = allMatch();
    expect((await call('GET', S())).body).toMatchObject({ editModeEnabled: false });
    const workflowId = `g945q1.edit.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'e1', typeId: 'feature.creative-briefs.nodes.edit-product-scene', inputs: { orgId, productId, prompt: 'A kitchen.', provider: 'mock' } }], edges: [] });
    const before = (await listAssets(TENANT, orgId)).length;
    const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
    const s = await settle(runId);
    expect((await listAssets(TENANT, orgId)).length, 'nothing was cut out or generated — refused before any spend').toBe(before);
    expect(s.status).toBe('failed');
    expect(JSON.stringify(s.error)).toMatch(/edit_mode_not_enabled/);
  }, 60_000);

  it('an org admin turns it on, and the edit then runs; a non-boolean is refused', async () => {
    expect((await call('PUT', S(), { editModeEnabled: 'yes' })).status).toBe(400);
    const on = await call('PUT', S(), { editModeEnabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ editModeEnabled: true });
    judgeImpl = allMatch();
    const workflowId = `g945q1.edit-on.${Date.now()}`;
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'e1', typeId: 'feature.creative-briefs.nodes.edit-product-scene', inputs: { orgId, productId, prompt: 'A kitchen.', provider: 'mock' } }], edges: [] });
    const runId = (await call('POST', '/runs', { workflowId, inputs: {} })).body.runId as string;
    await completed(runId);
    await call('PUT', S(), { editModeEnabled: false });
  }, 60_000);

  it('a viewer of the client cannot turn it on', async () => {
    const viewerCookie: { v: string } = { v: '' };
    const vcall = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(viewerCookie.v ? { cookie: viewerCookie.v } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) viewerCookie.v = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
    };
    const login = await vcall('POST', '/host/openwop-app/test/login', { email: `g945q1-viewer-${Date.now()}@acme.test`, tenantId: TENANT });
    const viewerId = (login.body as unknown as { user: { userId: string } }).user.userId;
    const add = await call('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Viewer', subject: viewerId, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await vcall('GET', S())).status).toBe(200);
    expect((await vcall('PUT', S(), { editModeEnabled: true })).status).toBe(403);
    expect((await call('GET', S())).body).toMatchObject({ editModeEnabled: false });
  }, 60_000);
});
