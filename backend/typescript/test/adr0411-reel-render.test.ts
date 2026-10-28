/**
 * ADR 0411 P3 — the reel (video) render CORE: the brief→text-to-video prompt
 * derivation (pure) and the reel-render storage (a `reel`-marked CreativeRender
 * whose mediaAssetId is the generated video's Media token, with a real brand
 * snapshot and empty image layers). The async video call + Media-asset
 * registration ride the `generate-reel` node (P3a wiring) over this core.
 *
 * TST-BQR-13. The prompt is asserted as a hand-written literal, so dropping or
 * reordering ANY production field (title, direction label, scene, composition,
 * camera, lighting, message) reds it. Red also when a reel render loses its
 * video mediaAssetId, gains image layers, mis-names its template, or stops
 * recording the honest no-brand-kit degradation.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { reelPromptForBrief, storeReelRender } from '../src/features/creative-briefs/render/renderService.js';

const T = 'tenant-reel';
const ORG = 'org-reel';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('ADR 0411 P3 — reel render core', () => {
  it('reelPromptForBrief derives a text-to-video prompt from the brief production fields', async () => {
    const brief = await createBrief(T, ORG, 'u1', {
      title: 'Summer Launch', sceneDescription: 'a beach at golden hour', composition: 'wide shot',
      cameraAngle: 'low angle', lighting: 'warm', messagingIntent: 'aspirational escape',
      directions: [{ label: 'Bold & bright' }],
    });
    const prompt = reelPromptForBrief(brief, 0);
    expect(prompt).toBe(
      'Summer Launch. Bold & bright. a beach at golden hour. Composition: wide shot. '
      + 'Camera: low angle. Lighting: warm. Message: aspirational escape',
    );
  });

  it('storeReelRender persists a reel-marked render (video mediaAssetId, real brand snapshot, empty layers)', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Reel', sceneDescription: 'a fox running through snow' });
    const render = await storeReelRender({
      tenantId: T, orgId: ORG, briefId: brief.briefId, actor: 'u1',
      videoAssetId: 'media:vid-1', prompt: 'a fox running', durationSeconds: 8, aspectRatio: '9:16', provider: 'replicate',
    });
    expect(render.reel?.prompt).toBe('a fox running');
    expect(render.reel?.aspectRatio).toBe('9:16');
    expect(render.reel?.durationSeconds).toBe(8);
    expect(render.mediaAssetId).toBe('media:vid-1'); // the video's Media token
    expect(render.layerAssets).toEqual({});           // a reel has no composed image layers
    // Real snapshot: no brand kit in this org ⇒ neutral defaults + an honest warning.
    expect(render.brand.brandId).toBeUndefined();
    expect(render.warnings.map((w) => w.code)).toContain('no-brand-kit');
    expect(render.brand.fontFamilies.sans.length).toBeGreaterThan(0);
    expect(render.templateId).toBe('reel-9x16');
    expect(render.compositeHash).toMatch(/^[0-9a-f]{64}$/); // real sha256 provenance
  });
});
