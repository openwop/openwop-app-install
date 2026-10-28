/**
 * ADR 0411 P3 — the generate-reel NODE orchestration: derive prompt → generate
 * video (ctx.callVideoGenerator) → promote to a durable Media asset
 * (createAssetFromServeUrl) → store a reel render. Tested with the REAL
 * creative-briefs surface + mock media/video ctx. Pins the deterministic
 * renderId (replay/fork idempotency) + the host-capability guard.
 *
 * TST-BQR-12. Red when: the renderId stops being derived from (runId, nodeId);
 * a re-run writes a SECOND/new render instead of converging (the re-run is
 * 60 s later on a faked Date, and the brief's renders are COUNTED, so an
 * overwrite with a fresh createdAt also shows); the promoted Media asset is not
 * the one stored on the render; the prompt loses the brief title; the
 * `ctx.callVideoGenerator` capability guard is removed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateReel } from '../../../packs/feature.creative-briefs.nodes/index.mjs';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { buildCreativeBriefsSurface } from '../src/features/creative-briefs/surface.js';
import { listRenders } from '../src/features/creative-briefs/render/renderService.js';

const T = 'tenant-reel-node';
const ORG = 'org-reel-node';

interface NodeOut { status: string; outputs: { render: { renderId: string; reel?: { prompt: string }; createdAt: string; mediaAssetId: string }; mediaAssetId: string } }

function mockCtx(overrides: Record<string, unknown>): Record<string, unknown> {
  const cb = buildCreativeBriefsSurface({ tenantId: T, runId: 'run-1' });
  const media = { createAssetFromServeUrl: async (a: { url: string }) => ({ assetId: `masset:${a.url.replace(/\W/g, '').slice(-8)}` }) };
  return {
    runId: 'run-1', nodeId: 'node-1',
    features: { 'creative-briefs': cb, media },
    callVideoGenerator: async () => ({ video: { url: 'serve://tok-vid-1', durationSeconds: 8, mimeType: 'video/mp4', metadata: { provider: 'replicate' } } }),
    ...overrides,
  };
}

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(() => { vi.useRealTimers(); });

describe('ADR 0411 P3 — generate-reel node', () => {
  it('derives prompt → generates → promotes to a Media asset → stores a reel render with a DETERMINISTIC id', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Winter Drop', sceneDescription: 'snow on pines' });
    const out = (await generateReel(mockCtx({ inputs: { orgId: ORG, briefId: brief.briefId, aspectRatio: '9:16' } }))) as NodeOut;
    expect(out.status).toBe('success');
    expect(out.outputs.render.renderId).toBe('crender:run-1:node-1'); // deterministic ⇒ replay/fork-safe
    expect(out.outputs.render.reel?.prompt).toContain('Winter Drop');
    // The promoted durable Media asset (the mock maps serve://tok-vid-1 → its
    // last 8 word chars) is the one the render stores.
    expect(out.outputs.mediaAssetId).toBe('masset:etokvid1');
    expect(out.outputs.render.mediaAssetId).toBe('masset:etokvid1');
  });

  it('is idempotent on re-run (same deterministic id ⇒ converges, never duplicates the render)', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'Idem', sceneDescription: 'x' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-07-01T00:00:00.000Z'));
    const first = (await generateReel(mockCtx({ inputs: { orgId: ORG, briefId: brief.briefId } }))) as NodeOut;
    vi.setSystemTime(Date.parse('2026-07-01T00:01:00.000Z')); // a re-run a minute later
    const second = (await generateReel(mockCtx({ inputs: { orgId: ORG, briefId: brief.briefId } }))) as NodeOut;
    expect(second.outputs.render.renderId).toBe(first.outputs.render.renderId);
    expect(first.outputs.render.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(second.outputs.render.createdAt).toBe('2026-07-01T00:00:00.000Z'); // the SAME row returned, not a rewrite
    expect(await listRenders(T, ORG, brief.briefId)).toHaveLength(1); // never duplicates
  });

  it('fails typed host_capability_missing when the host does not wire ctx.callVideoGenerator', async () => {
    const brief = await createBrief(T, ORG, 'u1', { title: 'NoVid', sceneDescription: 'x' });
    await expect(generateReel(mockCtx({ inputs: { orgId: ORG, briefId: brief.briefId }, callVideoGenerator: undefined })))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});
