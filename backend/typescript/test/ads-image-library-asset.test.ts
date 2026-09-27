/**
 * ADR 0083 §Amendment (gap closure) — the `vendor.myndhyve.ads-image-generate`
 * pack now emits the host media-output convention `images:[{contentBase64|url}]`
 * (was `assets:[{base64}]`, a divergent convention that the run-artifact producer
 * didn't recognize, so generated ad images never reached the Library). This proves
 * the node's output shape AND that it mints a real media: Library asset end-to-end.
 * The pack is orphaned (unwired), so this is a latent-conformance guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { persistRunArtifact, __resetRunArtifactStore } from '../src/host/runArtifactStore.js';
import { listArtifacts, isLibraryAsset } from '../src/host/artifactProjection.js';
import { __resetMedia } from '../src/features/media/mediaService.js';
import { adsImageGenerate as adsImage } from '../../../packs/vendor.myndhyve.ads-image-generate/index.mjs';

// A tiny valid base64 PNG (decodes to real bytes so it clears the ART-6 floor).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** ctx with a stub host image generator returning one base64 image per call. */
const ctx = (prompts: string[]) => ({
  inputs: { prompts },
  config: {},
  callImageGenerator: async () => ({ images: [{ base64: PNG_B64, mimeType: 'image/png' }] }),
});

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetRunArtifactStore();
  await __resetMedia();
});

describe('ads-image-generate → Library asset (ADR 0083 §Amendment)', () => {
  it('emits images:[{contentBase64}] (the host convention), not assets:[{base64}]', async () => {
    const res = await adsImage(ctx(['a bold product hero']));
    expect(res.status).toBe('success');
    const outputs = res.outputs ?? {};
    expect(outputs.assets).toBeUndefined();
    const images = outputs.images as Array<{ contentBase64?: string }>;
    expect(Array.isArray(images)).toBe(true);
    expect(images[0]?.contentBase64).toBe(PNG_B64);
  });

  it('its output mints media: Library assets via the run-artifact producer', async () => {
    const res = await adsImage(ctx(['a', 'b'])); // 2 prompts → 2 images
    const r = await persistRunArtifact({
      tenantId: 'tAds', runId: 'adRun', nodeId: 'gen', role: 'deliverable',
      output: res.outputs, now: '2026-07-05T00:00:00Z',
    });
    // Minted a media asset, NOT a raw run-event `data` blob.
    expect(r?.artifactId).toMatch(/^media:/);
    const lib = await listArtifacts('tAds', undefined);
    const media = lib.filter((a) => a.source === 'media');
    expect(media.length).toBeGreaterThanOrEqual(2); // multi-image capture
    expect(media.every(isLibraryAsset)).toBe(true); // the asset filter keeps them
    // And no raw `data` run-event row leaked in.
    expect(lib.some((a) => a.source === 'run-event' && a.kind === 'data')).toBe(false);
  });
});
