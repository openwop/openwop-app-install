/**
 * ADR 0820 G3 — executor host capabilities resolve their owning feature:
 * `ctx.canvas` per canvas type, `ctx.ads` per method, `ctx.callVideoGenerator`
 * per node type; the slides draft node propagates a refusal. Observed RED on unmodified source: every refusal below was
 * served. Each refusal has an operator-tenant positive control. Harness:
 * `monetizationGateHarness.ts`.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvasForTenant, createCanvasSurface, getCanvasForTenant, listCanvasesForTenant } from '../src/host/canvasSurface.js';
import { canvasTypeOwners } from '../src/host/canvasTypeOwnership.js';
import { collabCanvasType } from '../src/host/collab/collabRegistry.js';
import { useMonetizationHarness, FREE_TENANT, OPERATOR_TENANT, runNode } from './monetizationGateHarness.js';

useMonetizationHarness();

describe('G3 — ctx.canvas resolves the canvas TYPE\'s owning feature', () => {
  it('every canvas type the editor routes mount has an owner, and collab agrees with it', () => {
    const owners = canvasTypeOwners();
    for (const [type, toggle] of [['canvas.slides', 'slides'], ['canvas.cad', 'cad'], ['canvas.drawing', 'drawings'], ['canvas.campaign', 'campaign-studio'], ['canvas.app-builder', 'app-builder'], ['canvas.document', 'document-editor']] as const) {
      expect(owners.get(type), type).toBe(toggle);
    }
    for (const [type, toggle] of owners) {
      const collab = collabCanvasType(type);
      if (collab) expect(collab.toggleId, type).toBe(toggle);
    }
  });

  it('read / write / create of a paid type are refused for the unentitled tenant; a core type is not', async () => {
    const slides = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck', initialState: { slides: [] } });
    const surface = createCanvasSurface({ tenantId: FREE_TENANT });
    await expect(surface.read(slides.canvasId)).rejects.toMatchObject({ code: 'host_capability_disabled', feature: 'slides' });
    await expect(surface.write(slides.canvasId, { title: 'pwned' })).rejects.toMatchObject({ code: 'host_capability_disabled' });
    expect((await getCanvasForTenant(FREE_TENANT, slides.canvasId))?.version).toBe(1); // no write happened
    const before = (await listCanvasesForTenant(FREE_TENANT)).length;
    await expect(surface.create({ canvasTypeId: 'canvas.app-builder', name: 'App' })).rejects.toMatchObject({ code: 'host_capability_disabled', feature: 'app-builder' });
    expect((await listCanvasesForTenant(FREE_TENANT)).length).toBe(before); // nothing created
    // A type no feature owns is core host.canvas and stays usable.
    const core = await surface.create({ canvasTypeId: 'test.mzb1.core-canvas', name: 'Core' });
    await expect(surface.read(core.canvasId)).resolves.toMatchObject({ canvasTypeId: 'test.mzb1.core-canvas' });
  });

  it('the executor\'s ctx.canvas carries the gate (operator served, free tenant refused)', async () => {
    const free = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck' });
    const op = await createCanvasForTenant(OPERATOR_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck' });
    expect(await runNode(FREE_TENANT, 'test.mzb1.canvas-read-free', (ctx) => ctx.canvas.read(free.canvasId))).toEqual({ ok: false, code: 'host_capability_disabled' });
    expect(await runNode(OPERATOR_TENANT, 'test.mzb1.canvas-read-op', (ctx) => ctx.canvas.read(op.canvasId))).toMatchObject({ ok: true });
  });
});

describe('G3 — ctx.ads checks campaign-channels / campaign-connectors per method', () => {
  it('listDispatches (campaign-connectors) is refused for the free tenant and served for the operator', async () => {
    expect(await runNode(FREE_TENANT, 'test.mzb1.ads-list-free', (ctx) => ctx.ads.listDispatches())).toEqual({ ok: false, code: 'host_capability_disabled' });
    expect(await runNode(OPERATOR_TENANT, 'test.mzb1.ads-list-op', (ctx) => ctx.ads.listDispatches())).toEqual({ ok: true, value: [] });
  });

  it('publishAd (campaign-channels) is refused before any dispatch work', async () => {
    const r = await runNode(FREE_TENANT, 'test.mzb1.ads-publish-free', (ctx) => ctx.ads.publishAd({ platform: 'meta', briefId: 'b1', adAccountId: 'act_1', campaignName: 'C', copy: { headline: 'h' }, dryRun: true }));
    expect(r).toEqual({ ok: false, code: 'host_capability_disabled' });
  });
});

describe('G3 — ctx.callVideoGenerator is creative-video (creative-briefs for its own reel node)', () => {
  const req = { prompt: 'a cat', durationSeconds: 4 };
  it('a generic node is refused for the free tenant; the operator reaches the provider seam', async () => {
    expect(await runNode(FREE_TENANT, 'test.mzb1.video-free', (ctx) => ctx.callVideoGenerator(req))).toEqual({ ok: false, code: 'host_capability_disabled' });
    const op = await runNode(OPERATOR_TENANT, 'test.mzb1.video-op', (ctx) => ctx.callVideoGenerator(req));
    // No provider is configured in the test host, so the call fails AFTER the
    // gate — what matters is that it was not refused by it.
    expect(op).not.toEqual({ ok: false, code: 'host_capability_disabled' });
    expect(op).not.toEqual({ ok: false, code: 'node_never_ran' });
  });
});

describe('G3 — the slides draft node no longer swallows a slides refusal', () => {
  const deck = JSON.stringify({ title: 'T', theme: 'default', slides: [{ layout: 'blocks', variant: 'full', blocks: [{ type: 'heading', props: { text: 'Hi' } }] }] });
  const ctxWith = (getCatalog: () => Promise<unknown>) => ({
    inputs: { outline: { title: 'T', slides: [{ title: 'Hi', keyPoints: ['a'] }] } },
    config: {},
    callAI: async () => ({ content: deck }),
    features: { slides: { getCatalog } },
  });
  it('a host_capability_disabled refusal fails the node instead of falling back to the pinned catalog', async () => {
    const pack = await import(pathToFileURL(join(__dirname, '..', '..', '..', 'packs', 'feature.slides.nodes', 'index.mjs')).href);
    const refused = () => Promise.reject(Object.assign(new Error('off'), { code: 'host_capability_disabled' }));
    await expect(pack.draft(ctxWith(refused))).rejects.toMatchObject({ code: 'host_capability_disabled' });
    // Positive control: a serving surface yields a deck.
    const served = await pack.draft(ctxWith(async () => ({ blockTypeList: 'heading, text' })));
    expect(served).toMatchObject({ status: 'success' });
    // A host WITHOUT the slides surface keeps the pinned literal (portability).
    const bare = await pack.draft({ ...ctxWith(refused), features: {} });
    expect(bare).toMatchObject({ status: 'success' });
  });
});
