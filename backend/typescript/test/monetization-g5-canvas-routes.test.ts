/**
 * ADR 0820 G5 — app-builder export/publish/sync require `app-builder`; the
 * ui-plugin canvas RPC and `documents/from-canvas` require the source canvas
 * type's feature. Observed RED on unmodified source: every refusal below was
 * served. Harness: `monetizationGateHarness.ts`.
 *
 * DOUBLE GUARD (recorded, ADR 0820 §4): `code-export` / `code-publish` /
 * `code-sync` are themselves sub-toggles in the app-builder bundle
 * (`distributions/bundles.json`), so the free tenant is refused by EITHER gate.
 * The refusal's `details.feature` says which one fired: the G5 gate runs first and
 * names `app-builder`; without it the code-* gate answers with its own id (probe
 * w47g1-g5-code).
 */
import { describe, expect, it } from 'vitest';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { dispatcherForTenant } from '../src/routes/uiPlugins.js';
import { UI_PLUGIN_PROTOCOL } from '../src/host/uiPluginRpc.js';
import { useMonetizationHarness, FREE_TENANT, OPERATOR_TENANT, workspace, type Res } from './monetizationGateHarness.js';

useMonetizationHarness();

interface PlanRefusal { error: string; message: string; details?: { feature?: string } }
const isPlanRefusal = (r: Res, feature: string): void => {
  expect(r.status, JSON.stringify(r.body)).toBe(403);
  const body: PlanRefusal = r.body;
  expect(body).toMatchObject({ error: 'forbidden', details: { feature } });
  expect(body.message).toMatch(/does not include this/);
};

describe('G5 — app-builder export / publish / sync require app-builder, not only the code-* toggles', () => {
  const AB = (orgId: string, canvasId: string, verb: string) => `/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}/canvases/${canvasId}/${verb}`;

  it('export, publish and sync are refused (403, app-builder) for the free tenant; the operator passes the gate on each', async () => {
    const free = await workspace(FREE_TENANT);
    const app = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.app-builder', name: 'App', initialState: { name: 'App', screens: [] } });
    isPlanRefusal(await free.post(AB(free.orgId, app.canvasId, 'export'), { target: 'not-a-target' }), 'app-builder');
    isPlanRefusal(await free.post(AB(free.orgId, app.canvasId, 'publish'), { target: 'not-a-target', repo: 'acme/app' }), 'app-builder');
    isPlanRefusal(await free.post(AB(free.orgId, app.canvasId, 'sync'), {}), 'app-builder');

    // Positive controls: past the gate, each verb reaches its own validation.
    const op = await workspace(OPERATOR_TENANT);
    const opApp = await createCanvasForTenant(OPERATOR_TENANT, { canvasTypeId: 'canvas.app-builder', name: 'App', initialState: { name: 'App', screens: [] } });
    const exported = await op.post(AB(op.orgId, opApp.canvasId, 'export'), { target: 'not-a-target' });
    expect(exported.status, JSON.stringify(exported.body)).toBe(400);
    expect(exported.body).toMatchObject({ error: 'validation_error', details: { field: 'target' } });
    const published = await op.post(AB(op.orgId, opApp.canvasId, 'publish'), { target: 'not-a-target', repo: 'acme/app' });
    expect(published.status, JSON.stringify(published.body)).toBe(400);
    expect(published.body).toMatchObject({ error: 'validation_error', details: { field: 'target' } });
    const synced = await op.post(AB(op.orgId, opApp.canvasId, 'sync'), {});
    expect(synced.status, JSON.stringify(synced.body)).toBe(409);
    expect(synced.body).toMatchObject({ error: 'invalid_request' });
    expect(String(synced.body.message)).toMatch(/no repo binding/);
  });
});

describe('G5 — the ui-plugin canvas RPC requires app-builder', () => {
  const rpc = (id: number, method: string, params: unknown) => ({ openwop: UI_PLUGIN_PROTOCOL, id, type: 'request', method, params });
  it('read and write are refused for the free tenant; the operator reads', async () => {
    const free = await workspace(FREE_TENANT);
    const app = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.app-builder', name: 'App', initialState: { name: 'App' } });
    expect(await dispatcherForTenant(FREE_TENANT, { subject: free.userId })(rpc(1, 'artifact.read', { artifactId: app.canvasId })))
      .toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
    expect(await dispatcherForTenant(FREE_TENANT, { subject: free.userId })(rpc(2, 'artifact.write', { artifactId: app.canvasId, version: '1', payload: { name: 'pwned' } })))
      .toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
    expect((await getCanvasForTenant(FREE_TENANT, app.canvasId))?.version).toBe(1);

    const op = await workspace(OPERATOR_TENANT);
    const opApp = await createCanvasForTenant(OPERATOR_TENANT, { canvasTypeId: 'canvas.app-builder', name: 'App', initialState: { name: 'App' } });
    expect(await dispatcherForTenant(OPERATOR_TENANT, { subject: op.userId })(rpc(3, 'artifact.read', { artifactId: opApp.canvasId })))
      .toMatchObject({ ok: true });
  });
});

describe('G5 — documents/from-canvas requires the SOURCE canvas type\'s feature', () => {
  it('the free tenant (documents in plan, slides not) cannot materialize a slides canvas; the operator can', async () => {
    const free = await workspace(FREE_TENANT);
    const deck = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck', initialState: { title: 'Deck', slides: [] } });
    const refused = await free.post(`/host/openwop-app/documents/orgs/${encodeURIComponent(free.orgId)}/documents/from-canvas`, { canvasId: deck.canvasId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden', message: 'Your plan does not include this canvas type.', details: { feature: 'slides', reason: 'plan' } });

    // Positive control 1: the SAME free tenant materializes a core canvas type.
    const core = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'test.mzb1.core-canvas', name: 'Notes', initialState: { title: 'Notes' } });
    const coreOk = await free.post(`/host/openwop-app/documents/orgs/${encodeURIComponent(free.orgId)}/documents/from-canvas`, { canvasId: core.canvasId });
    expect([200, 201], JSON.stringify(coreOk.body)).toContain(coreOk.status);

    // Positive control 2: the operator materializes a slides canvas.
    const op = await workspace(OPERATOR_TENANT);
    const opDeck = await createCanvasForTenant(OPERATOR_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck', initialState: { title: 'Deck', slides: [] } });
    const ok = await op.post(`/host/openwop-app/documents/orgs/${encodeURIComponent(op.orgId)}/documents/from-canvas`, { canvasId: opDeck.canvasId });
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
  });
});
