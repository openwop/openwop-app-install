/**
 * ADR 0945 P3 — the creative publish-edge gate, at the real chokepoints.
 *
 * Exit criteria (ADR 0945 § Phased plan, P3): ungrounded and unverified AI
 * product imagery is refused at publish; non-AI assets are untouched.
 *  - `assertCreativePublishable` directly: every refusal, the fail-closed
 *    verdict read, the review-approval seam, scratch AI bytes, disclosure rows.
 *  - `adsAdapter.publishAd` (dry-run, so no platform call): the refusal comes
 *    back as `failed:<code>` before any preview; a non-AI asset previews.
 *  - campaign-ops `cmsPageAdapter.preview`/`write`: an edit that swaps a page
 *    image to unverified AI creative is refused `creative_blocked`.
 * Breaks if the gate trusts the asset's cached verdict summary, passes a
 * needs_review asset with no approval, lets AI scratch bytes through, stops
 * resolving a bare serve token, or is unwired from either chokepoint.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

let verdictStoreDown = false;
let mediaStoreDown = false;
vi.mock('../src/host/creativeFidelity/verdictStore.js', async (orig) => {
  const mod = await orig<typeof import('../src/host/creativeFidelity/verdictStore.js')>();
  return { ...mod, getVerdict: async (...a: Parameters<typeof mod.getVerdict>) => { if (verdictStoreDown) throw new Error('store down'); return mod.getVerdict(...a); } };
});
vi.mock('../src/features/media/mediaService.js', async (orig) => {
  const mod = await orig<typeof import('../src/features/media/mediaService.js')>();
  return { ...mod, getAssetByIdForTenant: async (...a: Parameters<typeof mod.getAssetByIdForTenant>) => {
    if (mediaStoreDown) throw new Error('media store down');
    return mod.getAssetByIdForTenant(...a);
  } };
});

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { assertCreativePublishable, registerCreativeReviewApproval } from '../src/host/creativePublishGate.js';
import { recordVerdict, verdictIdFor, FIDELITY_RULESET_VERSION, type FidelityVerdict } from '../src/host/creativeFidelity/index.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { createAsset, updateAsset, type MediaAsset } from '../src/features/media/mediaService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { cmsPageAdapter } from '../src/features/campaign-ops/adapters/cmsPage.js';

const T = 'org:g945p3';
const ORG = 'org-c1';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await storage.insertRun({ runId: 'run-p3', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterEach(() => { verdictStoreDown = false; mediaStoreDown = false; registerCreativeReviewApproval(null); });
afterAll(() => { registerCreativeReviewApproval(null); });

/** A distinct asset per call (unique bytes ⇒ no dedup). */
async function asset(opts: { lineage?: unknown; grounding?: unknown; marketing?: unknown } = {}): Promise<MediaAsset> {
  const b64 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(`#${++n}`)]).toString('base64');
  const s = await mediaStorage.put(T, { contentBase64: b64, contentType: 'image/png' });
  return createAsset({ tenantId: T, orgId: ORG, name: 'a.png', contentType: 'image/png', sizeBytes: s.sizeBytes, storageRef: s.storageRef, serveToken: s.serveToken, uploadedBy: 'u', contentHash: createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'), ...opts });
}
const grounded = (fidelity?: { verdictId: string; outcome: 'pass' | 'fail' | 'needs_review' }) => ({
  mode: 'composite', productId: 'prod:mug', sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], provider: 'openwop', model: 'renderer@x', op: 'render',
  ...(fidelity ? { fidelity: { ...fidelity, rulesetVersion: FIDELITY_RULESET_VERSION } } : {}),
});
async function withVerdict(outcome: FidelityVerdict['outcome'], summaryOutcome = outcome, override: Partial<FidelityVerdict> = {}): Promise<MediaAsset> {
  const verdictId = `fvd:${outcome}-${++n}`;
  const a = await asset({ lineage: { generatedBy: 'ai' }, grounding: grounded({ verdictId, outcome: summaryOutcome }) });
  await recordVerdict({ verdictId, tenantId: T, orgId: ORG, assetId: a.assetId, assetSha256: a.contentHash!, mode: 'composite', productId: 'prod:mug', sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], checks: [], outcome, rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: '2026-10-20T00:00:00Z', ...override });
  return a;
}
const gate = (mediaRef: string, destination: Parameters<typeof assertCreativePublishable>[0]['destination'] = 'ads:meta', political = false) =>
  assertCreativePublishable({ tenantId: T, mediaRef, destination, context: { political } });

describe('assertCreativePublishable', () => {
  it('new judge evidence or a new model-check invocation cannot reuse an older review identity', () => {
    const judge: NonNullable<FidelityVerdict['judge']> = { provider: 'mock', repaired: false, results: [{ attribute: 'logo', answer: 'not_visible', evidence: 'The logo is hidden' }] };
    const input = { assetId: 'masset:identity', assetSha256: 'a'.repeat(64), mode: 'edit', rulesetVersion: FIDELITY_RULESET_VERSION, sources: [{ sha256: 'b'.repeat(64) }], outcome: 'needs_review', checks: [], judge, invocation: 'run:original' };
    const original = verdictIdFor(input);
    expect(verdictIdFor(input)).toBe(original);
    expect(verdictIdFor({ ...input, invocation: 'run:new-check' })).not.toBe(original);
    expect(verdictIdFor({ ...input, judge: { ...judge, results: [{ attribute: 'logo', answer: 'not_visible', evidence: 'The logo may have been removed' }] } })).not.toBe(original);
  });
  it('non-AI assets pass untouched, everywhere', async () => {
    const a = await asset({ marketing: { productId: 'prod:mug' } });
    for (const d of ['ads:meta', 'ads:tiktok', 'ads:google', 'ads:linkedin', 'openwop.cms.page'] as const) {
      expect((await gate(a.assetId, d)).ok, d).toBe(true);
    }
  });

  it('AI imagery bound to a product with no grounding sources ⇒ product_depiction_ungrounded', async () => {
    const a = await asset({ lineage: { generatedBy: 'ai' }, marketing: { productId: 'prod:mug' } });
    expect(await gate(a.assetId)).toMatchObject({ ok: false, code: 'product_depiction_ungrounded' });
  });

  it('grounded but never checked, or checked and failed ⇒ fidelity_unverified', async () => {
    const unchecked = await asset({ lineage: { generatedBy: 'ai' }, grounding: grounded() });
    expect(await gate(unchecked.assetId)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
    expect(await gate((await withVerdict('fail')).assetId)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
  });

  it('the STORE decides, not the asset\'s cached summary', async () => {
    const lying = await withVerdict('fail', 'pass');
    expect(await gate(lying.assetId)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
  });

  it('a verdict store that cannot be read fails CLOSED', async () => {
    const a = await withVerdict('pass');
    verdictStoreDown = true;
    expect(await gate(a.assetId)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
  });

  it('a passing product image publishes (and resolves from a bare serve token or URL too)', async () => {
    const a = await withVerdict('pass');
    expect((await gate(a.assetId)).ok).toBe(true);
    expect(await gate(a.serveToken)).toMatchObject({ ok: true, assetId: a.assetId });
    expect(await gate(mediaStorage.serveUrl(a.serveToken))).toMatchObject({ ok: true, assetId: a.assetId });
  });

  it('a failed media provenance read cannot turn a known AI asset into ordinary media', async () => {
    const a = await withVerdict('pass');
    expect((await gate(a.assetId)).ok).toBe(true);
    mediaStoreDown = true;
    expect(await gate(a.assetId)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
    expect(await gate(a.serveToken)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
  });

  it('a verdict cannot authorize a product reassignment or mismatched content, sources or rules', async () => {
    const a = await withVerdict('pass');
    expect((await gate(a.assetId)).ok).toBe(true);
    await updateAsset(T, ORG, a.assetId, { marketing: { productId: 'prod:different' } });
    expect(await gate(a.assetId)).toMatchObject({ ok: false, code: 'product_depiction_ungrounded' });
    const staleEvidence: Partial<FidelityVerdict>[] = [{ assetSha256: '0'.repeat(64) }, { productId: 'prod:other' }, { sources: [] }, { rulesetVersion: 'obsolete-rules' }];
    for (const override of staleEvidence) {
      const stale = await withVerdict('pass', 'pass', override);
      expect(await gate(stale.assetId)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
    }
  });

  it('an unconfirmed verdict insertion never returns a phantom passing record', async () => {
    const a = await withVerdict('pass');
    const storage = hostExtStorage();
    const actual = storage.kvCompareAndSwap.bind(storage);
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) =>
      args[0].startsWith('hostext:creative:fidelity-verdict:') ? { swapped: false, actual: null } : actual(...args));
    try {
      await expect(recordVerdict({ verdictId: `fvd:unconfirmed-${++n}`, tenantId: T, orgId: ORG, assetId: a.assetId, assetSha256: a.contentHash!, mode: 'composite', productId: 'prod:mug', sources: [], checks: [], outcome: 'pass', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'conflict' });
    } finally { fault.mockRestore(); }
  });

  it('needs_review is refused unless the approvals owner says THIS asset at THIS verdict was approved; a throwing check refuses', async () => {
    const a = await withVerdict('needs_review');
    expect(await gate(a.assetId)).toMatchObject({ ok: false, code: 'fidelity_needs_review' });
    const seen: unknown[] = [];
    registerCreativeReviewApproval(async (q) => { seen.push(q); return q.assetId === a.assetId; });
    expect((await gate(a.assetId)).ok).toBe(true);
    expect(seen[0]).toMatchObject({ tenantId: T, orgId: ORG, assetId: a.assetId, verdictId: a.lineage?.grounding?.fidelity?.verdictId });
    registerCreativeReviewApproval(async () => { throw new Error('approvals down'); });
    expect(await gate(a.assetId)).toMatchObject({ ok: false, code: 'fidelity_needs_review' });
  });

  it('AI bytes that are not a library asset cannot be checked ⇒ refused; plain scratch bytes are untouched', async () => {
    const ai = await storeMediaAsset(T, { contentBase64: PNG, contentType: 'image/png', aiOrigin: { provider: 'mock', op: 'generate' } });
    expect(await gate(ai.token)).toMatchObject({ ok: false, code: 'fidelity_unverified' });
    const plain = await storeMediaAsset(T, { contentBase64: PNG, contentType: 'image/png' });
    expect((await gate(plain.token)).ok).toBe(true);
  });

  it('disclosure: a platform AI flag no adapter can set refuses (TikTok; political Meta); elsewhere AI non-product creative passes', async () => {
    const scene = await asset({ lineage: { generatedBy: 'ai' } });
    expect(await gate(scene.assetId, 'ads:tiktok')).toMatchObject({ ok: false, code: 'disclosure_unsupported' });
    expect(await gate(scene.assetId, 'ads:meta', true)).toMatchObject({ ok: false, code: 'disclosure_unsupported' });
    expect(await gate(scene.assetId, 'ads:meta')).toMatchObject({ ok: true, disclosure: { required: false } });
    expect((await gate(scene.assetId, 'ads:linkedin')).ok).toBe(true);
    expect((await gate(scene.assetId, 'openwop.cms.page')).ok).toBe(true);
  });
});

describe('the chokepoints', () => {
  const ads = () => makeAdsAdapter({ storage, tenantId: T, runId: 'run-p3', actingUserId: 'u1', orgId: T });
  const args = (mediaAssetId: string) => ({ platform: 'meta' as const, briefId: `brief-${++n}`, adAccountId: 'act_1', campaignName: 'C', copy: { headline: 'H', primaryText: 'P' }, pageId: 'page_1', mediaAssetId, dryRun: true });

  it('publishAd refuses before any preview; a non-AI asset previews', async () => {
    const bad = await asset({ lineage: { generatedBy: 'ai' }, marketing: { productId: 'prod:mug' } });
    expect(await ads().publishAd(args(bad.assetId) as never)).toEqual({ outcome: 'failed', error: 'product_depiction_ungrounded' });
    const ok = await asset();
    expect((await ads().publishAd(args(ok.assetId) as never)).outcome).toBe('preview');
  });

  it('a CMS page edit that swaps an image to unverified AI creative is refused creative_blocked (preview and write)', async () => {
    const before = await asset();
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Landing', createdBy: 'u1', sections: [{ type: 'image', data: { token: before.serveToken, alt: 'mug' } }] });
    const sectionId = page.sections[0].sectionId;
    const field = `sections[${sectionId}].data.token`;
    const target = { orgId: ORG, locator: { pageId: page.pageId }, editableFields: [field] };
    const bad = await asset({ lineage: { generatedBy: 'ai' }, grounding: grounded() });
    const edits = [{ field, before: before.serveToken, after: bad.serveToken }];
    expect(await cmsPageAdapter.preview(target as never, edits, { tenantId: T })).toMatchObject({ refused: 'creative_blocked' });
    expect(await cmsPageAdapter.write(target as never, edits, { expectedVersion: page.version }, { tenantId: T, actingUserId: 'u1' })).toMatchObject({ kind: 'refused', reason: 'creative_blocked' });
    // A hero's image lives under `imageToken` — the same gate applies.
    const hero = await createPage({ tenantId: T, orgId: ORG, title: 'Hero', createdBy: 'u1', sections: [{ type: 'hero', data: { heading: 'Mugs', imageToken: before.serveToken } }] });
    const heroField = `sections[${hero.sections[0].sectionId}].data.imageToken`;
    expect(await cmsPageAdapter.preview({ orgId: ORG, locator: { pageId: hero.pageId }, editableFields: [heroField] } as never, [{ field: heroField, before: before.serveToken, after: bad.serveToken }], { tenantId: T })).toMatchObject({ refused: 'creative_blocked' });
    const fine = await asset();
    const ok = await cmsPageAdapter.preview(target as never, [{ field, before: before.serveToken, after: fine.serveToken }], { tenantId: T });
    expect('refused' in ok).toBe(false);
  });
});
