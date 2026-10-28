/**
 * ADR 0945 P0 — the renderer and the video finaliser stamp `lineage.grounding`.
 *
 * The renderer used to pass `lineage:{source, briefId, templateId}`, which
 * cleanLineage drops, so a composite carried no provenance at all (G3). It now
 * names the render that made it (`composedFrom`, with the render id minted
 * before the asset), pins every layer by id + hash, records `composite` when a
 * product layer is present, and is AI output only when a layer is.
 * The video finaliser records the FULL-prompt hash taken at submit (the stored
 * snippet is cut at 2000 chars).
 *
 * Breaks if the renderer drops composedFrom or the layer hashes, mints the
 * render id after the asset (the ids would disagree), marks an all-photo
 * composite as AI, or the video path hashes the snippet instead of the prompt.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { configureMediaBudget } from '../src/aiProviders/mediaBudget.js';
import { createBrief, __clearCreativeBriefs } from '../src/features/creative-briefs/creativeBriefsService.js';
import { renderForBrief, __clearCreativeRenders } from '../src/features/creative-briefs/render/renderService.js';
import { RENDERER_VERSION } from '../src/features/creative-briefs/render/renderCreative.js';
import { createAsset, getAsset, __resetMedia } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { textToVideo } from '../src/features/creative-video/videoService.js';
import { __clearVideoJobs } from '../src/features/creative-video/entities/videoJob.js';
import type { VideoAdapter } from '../src/features/creative-video/host/videoProviderAdapter.js';

const TENANT = 'org:g945-render';
const ORG = 'org-1';
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQDWUFLAAAAAAElFTkSuQmCC';
const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-g945-')) });
  configureMediaBudget({ storage });
  await __resetMedia(); await __clearCreativeRenders(); await __clearCreativeBriefs(); await __clearVideoJobs();
});

async function layer(b64: string, lineage?: unknown, marketing?: unknown) {
  const stored = await mediaStorage.put(TENANT, { contentBase64: b64, contentType: 'image/png' });
  return createAsset({ tenantId: TENANT, orgId: ORG, name: 'l.png', contentType: 'image/png', sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: 'u', contentHash: sha(b64), ...(lineage ? { lineage } : {}), ...(marketing ? { marketing } : {}) });
}

describe('renderer grounding (G3)', () => {
  it('a composite with a product layer: composite mode, composedFrom = THIS render, layers pinned; not AI when no layer is', async () => {
    const bg = await layer(PNG_A);
    const product = await layer(PNG_B, undefined, { productId: 'prod:mug', shotRole: 'hero' });
    const brief = await createBrief(TENANT, ORG, 'u', { title: 'Mug launch', assetType: 'image', sceneDescription: 'Kitchen.' });
    const render = await renderForBrief(TENANT, ORG, 'u', { briefId: brief.briefId, templateId: 'meta.feed.1x1', layers: { background: bg.assetId, product: product.assetId } });
    const asset = await getAsset(TENANT, ORG, render.mediaAssetId);
    expect(asset?.lineage?.grounding).toEqual({
      mode: 'composite', productId: 'prod:mug',
      sources: [{ assetId: bg.assetId, sha256: sha(PNG_A) }, { assetId: product.assetId, sha256: sha(PNG_B) }],
      provider: 'openwop', model: `renderer@${RENDERER_VERSION}`, op: 'render',
      composedFrom: { renderId: render.renderId, templateId: 'meta.feed.1x1', briefId: brief.briefId },
    });
    expect(asset?.lineage?.generatedBy, 'a composite of real photos is not AI output').toBeUndefined();
  }, 30_000);

  it('an AI layer makes the composite AI output; no product layer is mode none', async () => {
    const bg = await layer(PNG_A, { generatedBy: 'ai', prompt: 'a beach' });
    const brief = await createBrief(TENANT, ORG, 'u', { title: 'Beach', assetType: 'image', sceneDescription: 'Sand.' });
    const render = await renderForBrief(TENANT, ORG, 'u', { briefId: brief.briefId, templateId: 'meta.feed.1x1', layers: { background: bg.assetId } });
    const asset = await getAsset(TENANT, ORG, render.mediaAssetId);
    expect(asset?.lineage?.generatedBy).toBe('ai');
    expect(asset?.lineage?.grounding).toMatchObject({ mode: 'none', sources: [{ assetId: bg.assetId, sha256: sha(PNG_A) }] });
  }, 30_000);
});

describe('video finaliser grounding', () => {
  it('records the FULL prompt hash from submit, mode none, op text-to-video', async () => {
    const TINY = Buffer.from('fake-mp4-bytes-g945').toString('base64');
    const adapter: VideoAdapter = {
      async submitJob() { return { ok: true as const, value: { providerJobId: 'p-1' } }; },
      async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://example.invalid/r.mp4' } }; },
      async downloadResult() { return { ok: true as const, value: { base64: TINY, bytes: 19, contentType: 'video/mp4' } }; },
    };
    const prompt = `A slow pan. ${'detail '.repeat(400)}`;
    expect(prompt.length).toBeGreaterThan(2000);
    const out = await textToVideo({ storage: undefined as never, tenantId: TENANT, runId: 'run-1', actingUserId: 'u', orgId: ORG }, { tenantId: TENANT, orgId: ORG, prompt, createdBy: 'u' }, adapter);
    expect(out.status).toBe('completed');
    const asset = await getAsset(TENANT, ORG, (out as { assetId: string }).assetId);
    expect(asset?.lineage?.grounding).toMatchObject({ mode: 'none', sources: [], op: 'text-to-video', promptHash: createHash('sha256').update(prompt.trim()).digest('hex') });
  });
});
