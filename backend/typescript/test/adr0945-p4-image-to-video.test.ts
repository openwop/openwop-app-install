/**
 * ADR 0945 P4 (D7) — image-to-video on the ONE video job pipeline.
 *
 * Exit criteria (ADR 0945 § Phased plan, P4): the job reuses the one pipeline;
 * every product video stops at a gate.
 *  - a checked product shot (stored verdict `pass`) or a verified product photo
 *    animates; anything else is `product_depiction_ungrounded` with NO submit;
 *  - the result is stamped `animate` with its source pinned by id + hash, and a
 *    `needs_review` verdict, so the publish gate holds it for a person;
 *  - the same still dedups to one paid job, a different still does not, and
 *    every pre-existing avatar/t2v request hash is unchanged;
 *  - the Runway adapter posts `image_to_video` with the still as a data URI.
 * No network and no spend: a stub adapter and a captured broker.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const posted: Array<{ url: string; body: string }> = [];
vi.mock('../src/host/brokeredEgress.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/brokeredEgress.js')>()),
  brokeredPost: async (_d: unknown, req: { url: string; body: string }) => { posted.push({ url: req.url, body: req.body }); return { outcome: 'sent', res: { status: 200, json: async () => ({ id: 'task-1' }) } }; },
}));

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { configureMediaBudget, _resetMediaBudgetForTest } from '../src/aiProviders/mediaBudget.js';
import { createAsset, getAsset, registerProductSourceVerifier, __resetMedia } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { imageToVideo } from '../src/features/creative-video/videoService.js';
import { requestHashFor, __clearVideoJobs } from '../src/features/creative-video/entities/videoJob.js';
import { makeT2VAdapter } from '../src/features/creative-video/host/t2vProviderAdapter.js';
import type { VideoAdapter } from '../src/features/creative-video/host/videoProviderAdapter.js';
import { recordVerdict, getVerdict, FIDELITY_RULESET_VERSION, type FidelityVerdict } from '../src/host/creativeFidelity/index.js';
import { assertCreativePublishable } from '../src/host/creativePublishGate.js';
import { OpenwopError } from '../src/types.js';

const T = 'org:g945p4';
const ORG = 'org-1';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MP4 = Buffer.from('fake-mp4-g945p4').toString('base64');
const deps = { storage: undefined as never, tenantId: T, runId: 'run-1', actingUserId: 'u', orgId: ORG };
let n = 0;

function stub(): VideoAdapter & { submits: Array<Record<string, unknown>> } {
  const a = {
    submits: [] as Array<Record<string, unknown>>,
    async submitJob(input: Record<string, unknown>) { a.submits.push(input); return { ok: true as const, value: { providerJobId: `p-${a.submits.length}` } }; },
    async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://runwayml.com/out.mp4' } }; },
    async downloadResult() { return { ok: true as const, value: { base64: MP4, bytes: 15, contentType: 'video/mp4' } }; },
  };
  return a as never;
}

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-g945p4-')) });
  configureMediaBudget({ storage });
  _resetMediaBudgetForTest();
  await __resetMedia(); await __clearVideoJobs();
  posted.length = 0;
  registerProductSourceVerifier(async () => false);
});

async function still(opts: { grounding?: unknown } = {}) {
  const b64 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(`#${++n}`)]).toString('base64');
  const s = await mediaStorage.put(T, { contentBase64: b64, contentType: 'image/png' });
  const sha = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  return { asset: await createAsset({ tenantId: T, orgId: ORG, name: 's.png', contentType: 'image/png', sizeBytes: s.sizeBytes, storageRef: s.storageRef, serveToken: s.serveToken, uploadedBy: 'u', contentHash: sha, ...(opts.grounding ? { lineage: { generatedBy: 'ai' }, grounding: opts.grounding } : {}) }), sha };
}
async function checkedShot(outcome: 'pass' | 'needs_review', mismatch: Partial<Pick<FidelityVerdict, 'assetSha256' | 'productId' | 'mode' | 'sources' | 'rulesetVersion'>> = {}) {
  const verdictId = `fvd:${outcome}-${++n}`;
  const s = await still({ grounding: { mode: 'composite', productId: 'prod:mug', sources: [{ assetId: 'masset:x', sha256: 'a'.repeat(64) }], provider: 'openwop', model: 'r', op: 'render', fidelity: { verdictId, outcome, rulesetVersion: FIDELITY_RULESET_VERSION } } });
  await recordVerdict({ verdictId, tenantId: T, orgId: ORG, assetId: s.asset.assetId, assetSha256: s.sha, productId: 'prod:mug', mode: 'composite', sources: [{ assetId: 'masset:x', sha256: 'a'.repeat(64) }], checks: [], outcome, rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: 'x', ...mismatch });
  return s;
}
const go = (sourceAssetId: string, a: VideoAdapter, extra: { productId?: string; prompt?: string } = {}) =>
  imageToVideo(deps, { tenantId: T, orgId: ORG, sourceAssetId, prompt: extra.prompt ?? 'Slow turntable spin.', createdBy: 'u', ...(extra.productId ? { productId: extra.productId } : {}) }, a);

describe('image-to-video (D7)', () => {
  it('animates a checked product shot on the one pipeline; the video is stamped animate + needs_review, and the publish gate holds it', async () => {
    const s = await checkedShot('pass');
    const a = stub();
    const out = await go(s.asset.assetId, a);
    expect(out.status).toBe('completed');
    expect(a.submits).toHaveLength(1);
    expect(String(a.submits[0].promptImage)).toMatch(/^data:image\/png;base64,/);
    expect([a.submits[0].width, a.submits[0].height], 'a provider ratio, not the still\'s pixel size').toEqual([1280, 768]);
    const video = await getAsset(T, ORG, (out as { assetId: string }).assetId);
    expect(video?.lineage?.grounding).toMatchObject({ mode: 'animate', productId: 'prod:mug', op: 'image-to-video', sources: [{ assetId: s.asset.assetId, sha256: s.sha }] });
    const v = await getVerdict(T, ORG, video!.lineage!.grounding!.fidelity!.verdictId);
    expect(v?.outcome).toBe('needs_review');
    expect(await assertCreativePublishable({ tenantId: T, mediaRef: video!.assetId, destination: 'ads:meta' })).toMatchObject({ ok: false, code: 'fidelity_needs_review' });
  });

  it('a product photo animates only when the catalog confirms it is that product\'s photo', async () => {
    const s = await still();
    const a = stub();
    await expect(go(s.asset.assetId, a, { productId: 'prod:mug' })).rejects.toMatchObject({ code: 'product_depiction_ungrounded' });
    registerProductSourceVerifier(async (_t, _o, productId, sha) => productId === 'prod:mug' && sha === s.sha);
    const out = await go(s.asset.assetId, a, { productId: 'prod:mug' });
    expect(out.status).toBe('completed');
    expect((await getAsset(T, ORG, (out as { assetId: string }).assetId))?.lineage?.grounding?.productId).toBe('prod:mug');
  });

  it('an unchecked or under-review still is refused BEFORE any spend', async () => {
    const a = stub();
    const plain = await still();
    const err = await go(plain.asset.assetId, a).catch((e: unknown) => e);
    expect((err as OpenwopError).code).toBe('product_depiction_ungrounded');
    const review = await checkedShot('needs_review');
    await expect(go(review.asset.assetId, a)).rejects.toMatchObject({ code: 'product_depiction_ungrounded' });
    expect(a.submits).toHaveLength(0);
  });

  it('a passing verdict for different bytes, product, mode, sources or ruleset never authorizes paid animation', async () => {
    const a = stub();
    const mismatches: Array<Partial<Pick<FidelityVerdict, 'assetSha256' | 'productId' | 'mode' | 'sources' | 'rulesetVersion'>>> = [
      { assetSha256: 'b'.repeat(64) }, { productId: 'prod:other' }, { mode: 'edit' },
      { sources: [] }, { rulesetVersion: 'obsolete-rules' },
    ];
    for (const mismatch of mismatches) {
      const s = await checkedShot('pass', mismatch);
      await expect(go(s.asset.assetId, a)).rejects.toMatchObject({ code: 'product_depiction_ungrounded' });
      expect(a.submits).toHaveLength(0);
    }
  });

  it('the same still dedups to ONE paid job; a different still is a new job', async () => {
    const s1 = await checkedShot('pass');
    const s2 = await checkedShot('pass');
    const a = stub();
    await go(s1.asset.assetId, a);
    await go(s1.asset.assetId, a);
    expect(a.submits).toHaveLength(1);
    await go(s2.asset.assetId, a);
    expect(a.submits).toHaveLength(2);
  });

  it('every pre-existing avatar/t2v request hash is unchanged (no source ⇒ no new key)', () => {
    const input = { provider: 'runway', orgId: 'o', kind: 't2v' as const, script: 'x', avatarId: '' };
    const legacy = createHash('sha256').update(JSON.stringify({ p: 'runway', o: 'o', k: 't2v', m: '', s: 'x', a: '', v: '', w: 0, h: 0, d: 0 }), 'utf8').digest('hex');
    expect(requestHashFor(input)).toBe(legacy);
    expect(requestHashFor({ ...input, sourceSha256: 'b'.repeat(64) })).not.toBe(legacy);
  });

  it('the Runway adapter posts image_to_video with the still as promptImage; text-only stays text_to_video', async () => {
    const ad = makeT2VAdapter(deps as never);
    await ad.submitJob({ script: 'spin', avatarId: '', promptImage: 'data:image/png;base64,AAAA' });
    await ad.submitJob({ script: 'a beach', avatarId: '' });
    expect(posted[0].url).toMatch(/\/v1\/image_to_video$/);
    expect(JSON.parse(posted[0].body)).toMatchObject({ promptImage: 'data:image/png;base64,AAAA', promptText: 'spin' });
    expect(posted[1].url).toMatch(/\/v1\/text_to_video$/);
    expect(JSON.parse(posted[1].body).promptImage).toBeUndefined();
  });
});
