/**
 * ADR 1039 D3/D4 (CB82WF-3, CB82WF-4, CB82WF-8) — the generate-reel node spends
 * only when the render can be kept, and the provider is asked for the ratio the
 * render records.
 *
 * Red when: a brief at its render cap still reaches `callVideoGenerator`; a
 * retried node whose render already exists pays for a second video; the node
 * stops sending `width`/`height` for the requested ratio (the host ignores
 * `aspectRatio` and defaults to portrait); an unknown ratio reaches the provider;
 * or the stored render records a ratio other than the dimensions requested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateReel } from '../../../packs/feature.creative-briefs.nodes/index.mjs';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { buildCreativeBriefsSurface } from '../src/features/creative-briefs/surface.js';
import { __setRenderCapForTest, listRenders, storeReelRender } from '../src/features/creative-briefs/render/renderService.js';

const T = 'tenant-reel-spend';
const ORG = 'org-reel-spend';

interface VideoReq { width?: number; height?: number }
function ctxFor(runId: string, inputs: Record<string, unknown>, calls: VideoReq[]): Record<string, unknown> {
  const cb = buildCreativeBriefsSurface({ tenantId: T, runId });
  const media = { createAssetFromServeUrl: async (a: { url: string }) => ({ assetId: `masset:${a.url.replace(/\W/g, '').slice(-8)}` }) };
  return {
    runId, nodeId: 'reel', inputs: { credentialRef: 'replicate', ...inputs },
    features: { 'creative-briefs': cb, media },
    callVideoGenerator: async (req: VideoReq) => {
      calls.push(req);
      // The host echoes the requested, clamped geometry (aiProvidersHost: it does not demux the mp4).
      return { video: { url: `serve://tok-${runId}`, durationSeconds: 5, width: req.width ?? 1080, height: req.height ?? 1920, mimeType: 'video/mp4', metadata: { provider: 'replicate' } } };
    },
  };
}

let restoreCap: () => void = () => {};
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); restoreCap = __setRenderCapForTest(2); });
afterAll(() => { restoreCap(); });

describe('ADR 1039 D3 — spend only when the render can be kept', () => {
  it('a brief at its render cap makes no video call', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Full', sceneDescription: 'x' });
    for (const n of [1, 2]) await storeReelRender({ tenantId: T, orgId: ORG, briefId: brief.briefId, actor: 'u1', videoAssetId: `masset:v${n}`, prompt: 'p' });
    const calls: VideoReq[] = [];
    await expect(generateReel(ctxFor('run-full', { orgId: ORG, briefId: brief.briefId }, calls))).rejects.toMatchObject({ code: 'validation_error' });
    expect(calls).toHaveLength(0);
  });

  it('a retried node whose render exists returns it without paying again, even at cap', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Retry', sceneDescription: 'x' });
    const calls: VideoReq[] = [];
    const first = (await generateReel(ctxFor('run-retry', { orgId: ORG, briefId: brief.briefId }, calls))) as { status: string; outputs: { render: { renderId: string } } };
    await storeReelRender({ tenantId: T, orgId: ORG, briefId: brief.briefId, actor: 'u1', videoAssetId: 'masset:other', prompt: 'p' }); // now at cap
    const again = (await generateReel(ctxFor('run-retry', { orgId: ORG, briefId: brief.briefId }, calls))) as { status: string; outputs: { render: { renderId: string } } };
    expect(again.status).toBe('success');
    expect(again.outputs.render.renderId).toBe(first.outputs.render.renderId);
    expect(calls).toHaveLength(1);
    expect(await listRenders(T, ORG, brief.briefId)).toHaveLength(2);
  });
});

describe('ADR 1039 D4 — the provider is asked for the ratio the render records', () => {
  it.each([
    ['16:9', 1920, 1080],
    ['1:1', 1080, 1080],
    ['9:16', 1080, 1920],
  ])('%s is requested as %ix%i and recorded as such', async (aspectRatio, width, height) => {
    const brief = await createBrief(T, ORG, 'u1', { title: `Aspect ${aspectRatio}`, sceneDescription: 'x' });
    const calls: VideoReq[] = [];
    const out = (await generateReel(ctxFor(`run-${aspectRatio}`, { orgId: ORG, briefId: brief.briefId, aspectRatio }, calls))) as { status: string; outputs: { render: { templateId: string; reel: { aspectRatio?: string } } } };
    expect(calls[0]).toMatchObject({ width, height });
    expect(out.outputs.render.reel.aspectRatio).toBe(aspectRatio);
  });

  it('an absent ratio keeps the portrait default; an unknown one is refused before any call', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Aspect default', sceneDescription: 'x' });
    const calls: VideoReq[] = [];
    const out = (await generateReel(ctxFor('run-default', { orgId: ORG, briefId: brief.briefId, aspectRatio: '' }, calls))) as { status: string; outputs: { render: { reel: { aspectRatio?: string } } } };
    expect(calls[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(out.outputs.render.reel.aspectRatio).toBe('9:16');
    await expect(generateReel(ctxFor('run-bad', { orgId: ORG, briefId: brief.briefId, aspectRatio: '4:5' }, calls))).rejects.toMatchObject({ code: 'validation_error' });
    expect(calls).toHaveLength(1);
  });
});

describe('ADR 1039 D2/D3 — no key, no host call; concurrent reels converge on the cap', () => {
  it('a replicate reel with no credentialRef fails credential_required before any host call', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'No key', sceneDescription: 'x' });
    const calls: VideoReq[] = [];
    const ctx = ctxFor('run-nokey', { orgId: ORG, briefId: brief.briefId }, calls);
    ctx.inputs = { orgId: ORG, briefId: brief.briefId };
    let hostCalls = 0;
    const cb = ctx.features as Record<string, Record<string, (...a: unknown[]) => unknown>>;
    const realPrompt = cb['creative-briefs']!.reelPrompt!;
    cb['creative-briefs']!.reelPrompt = async (...a: unknown[]) => { hostCalls += 1; return realPrompt(...a); };
    await expect(generateReel(ctx)).rejects.toMatchObject({ code: 'credential_required' });
    expect(hostCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('two reels racing for the last slot: one is kept, the other is refused and pruned', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Race', sceneDescription: 'x' });
    await storeReelRender({ tenantId: T, orgId: ORG, briefId: brief.briefId, actor: 'u1', videoAssetId: 'masset:seed', prompt: 'p' }); // cap 2, one slot left
    const results = await Promise.allSettled(['a', 'b'].map((n) => storeReelRender({ tenantId: T, orgId: ORG, briefId: brief.briefId, actor: 'u1', videoAssetId: `masset:${n}`, prompt: 'p', renderId: `crender:race-${n}:reel` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await listRenders(T, ORG, brief.briefId)).toHaveLength(2);
  });
});
