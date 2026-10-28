/**
 * ADR 0945 P1 — product-grounded composites and the stage-A fidelity check.
 *
 * Composite mode (D2): the product's own pixels, background-removed by the
 * node's recorded image-edit call, are placed on a generated scene by the
 * deterministic ADR 0399 renderer — copied and only scaled. This module owns
 * the three host halves the `compose-product-shot` and `fidelity-check` nodes
 * call: hand the node a product source to cut out, compose the shot after
 * verifying the cut-out IS that product, and judge the result.
 *
 * Every AI call stays in the node (recorded, policy- and budget-checked like
 * every other generation node); nothing here dispatches a model.
 *
 * Reads commerce data, so every entry point asks the `commerce` feature first
 * (ADR 0820 §7 / G11), and the `creative-briefs.product-grounded` sub-toggle
 * (ADR 0941 D5 AND-gate; the parent toggle is the surface seam's).
 */
import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { featureAccessRefusal } from '../../host/workflowFeatureGate.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import {
  FIDELITY_RULESET_VERSION, combineOutcome, judgeOutcome, STAGE_A_RULES, imageSize, isRasterisable, productMask, protectionMaskPng,
  rasteriseCrop, rasteriseFull, rasteriseIntoSlot, recordVerdict, runFidelityJudge, runStageA, verdictIdFor,
  type FidelityCheck, type FidelityOutcome, type FidelityVerdict, type JudgeImage,
} from '../../host/creativeFidelity/index.js';
import { resolveHeadlessAiDescribed } from '../../host/headlessAi.js';
import { getAsset, setGroundingFidelity, type MediaAsset } from '../media/mediaService.js';
import { resolveProductMedia, type ProductSource } from '../commerce/productMedia.js';
import { getRender, renderForBrief, type CreativeRender } from './render/renderService.js';
import { imageLayerSlot } from './render/renderCreative.js';
import { assertEditModeEnabled } from './groundingSettings.js';
import { getTemplate } from './render/templates.js';

export const PRODUCT_GROUNDED_TOGGLE = 'creative-briefs.product-grounded';

/** The sub-toggle + the commerce source gate. Fails closed with the t2v
 *  precedent's typed 404 (the feature does not exist for this tenant). */
export async function assertProductGroundedEnabled(tenantId: string, userId?: string): Promise<void> {
  const a = await resolveOne(PRODUCT_GROUNDED_TOGGLE, { tenantId, ...(userId ? { userId } : {}) });
  if (!a || !a.enabled) {
    throw new OpenwopError('not_found', 'Product-grounded creative is not enabled for this workspace.', 404, { feature: PRODUCT_GROUNDED_TOGGLE });
  }
  const refusal = await featureAccessRefusal('commerce', tenantId, userId ? { userId } : {});
  if (refusal) {
    throw new OpenwopError('forbidden', refusal === 'plan'
      ? 'Product-grounded creative reads your product catalog, which is not included in this workspace\'s plan.'
      : 'Product-grounded creative reads your product catalog, which is not enabled for this workspace.', 403, { feature: 'commerce', reason: refusal });
  }
}

async function bytesOf(tenantId: string, a: MediaAsset): Promise<{ base64: string; sha256: string }> {
  const entry = await resolveMediaAsset(a.serveToken);
  if (!entry || entry.tenantId !== tenantId) throw new OpenwopError('not_found', 'Asset bytes unavailable.', 404, { assetId: a.assetId });
  return { base64: entry.contentBase64, sha256: createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex') };
}

/** One of the product's sources, WITH its bytes, for the node to cut out.
 *  The bytes stay inside the node (they never reach a node output); no serve
 *  token is returned (MED2-R2). `sourceAssetId` must be one of the product's
 *  sources; else the hero shot, else the first. */
export async function productShotSource(tenantId: string, orgId: string, productId: string, sourceAssetId?: string): Promise<{ assetId: string; sha256: string; role: ProductSource['role']; mimeType: string; contentBase64: string }> {
  const sources = await resolveProductMedia({ tenantId, orgId, productId });
  if (sources.length === 0) {
    throw new OpenwopError('product_depiction_ungrounded', 'This product has no images — attach product photos before generating creative that shows it.', 422, { productId });
  }
  const pick = sourceAssetId
    ? sources.find((s) => s.assetId === sourceAssetId)
    : sources.find((s) => s.role === 'hero') ?? sources[0];
  if (!pick) throw new OpenwopError('product_depiction_ungrounded', 'That image is not one of this product\'s photos.', 422, { productId, sourceAssetId });
  const asset = await getAsset(tenantId, orgId, pick.assetId);
  if (!asset) throw new OpenwopError('product_media_unresolved', 'A product image is no longer in the media library.', 422, { productId });
  if (!isRasterisable(asset.contentType)) {
    throw new OpenwopError('validation_error', `Product image is ${asset.contentType}; composites need PNG, JPEG or GIF.`, 422, { productId, contentType: asset.contentType });
  }
  const { base64 } = await bytesOf(tenantId, asset);
  return { assetId: pick.assetId, sha256: pick.sha256, role: pick.role, mimeType: asset.contentType, contentBase64: base64 };
}

/** Verify a cut-out IS the product: a background-remove derivative whose
 *  recorded source bytes are one of the product's sources. Matched by HASH —
 *  the bytes are the identity; the same bytes can sit under two asset ids. */
async function verifyCutout(tenantId: string, orgId: string, productId: string, cutoutAssetId: string): Promise<{ cutout: MediaAsset; source: ProductSource }> {
  const cutout = await getAsset(tenantId, orgId, cutoutAssetId);
  if (!cutout) throw new OpenwopError('not_found', 'Cut-out asset not found.', 404, { assetId: cutoutAssetId });
  const g = cutout.lineage?.grounding;
  const sources = await resolveProductMedia({ tenantId, orgId, productId });
  const source = g && g.mode === 'edit' && g.op === 'background-remove'
    ? sources.find((s) => g.sources.some((gs) => gs.sha256 === s.sha256))
    : undefined;
  if (!source) {
    throw new OpenwopError('product_depiction_ungrounded', 'The cut-out is not a background-removed copy of one of this product\'s photos.', 422, { productId, assetId: cutoutAssetId });
  }
  return { cutout, source };
}

/** Compose a product shot (composite mode). */
export async function composeProductShot(tenantId: string, orgId: string, actor: string, args: {
  productId: string; briefId: string; templateId: string; cutoutAssetId: string; backgroundAssetId: string;
  directionIndex?: number; copy?: Record<string, unknown>;
}): Promise<CreativeRender> {
  const template = getTemplate(args.templateId);
  if (!template) throw new OpenwopError('validation_error', 'Unknown templateId.', 400, { field: 'templateId' });
  if (!template.layers.some((l) => l.id === 'product' && l.kind === 'image')) {
    throw new OpenwopError('validation_error', `Template ${args.templateId} has no product slot — pick one that shows a product.`, 400, { field: 'templateId' });
  }
  if (args.backgroundAssetId === args.cutoutAssetId) {
    // The renderer drops a product layer that IS the background, which would
    // silently produce a product-less "product shot".
    throw new OpenwopError('validation_error', 'The background and the product cut-out are the same image.', 400, { field: 'backgroundAssetId' });
  }
  await verifyCutout(tenantId, orgId, args.productId, args.cutoutAssetId);
  const background = await getAsset(tenantId, orgId, args.backgroundAssetId);
  if (!background) throw new OpenwopError('not_found', 'Background asset not found.', 404, { assetId: args.backgroundAssetId });
  return renderForBrief(tenantId, orgId, actor, {
    briefId: args.briefId,
    templateId: args.templateId,
    layers: { background: args.backgroundAssetId, product: args.cutoutAssetId },
    verifiedProductId: args.productId,
    ...(args.directionIndex !== undefined ? { directionIndex: args.directionIndex } : {}),
    ...(args.copy ? { copy: args.copy } : {}),
  });
}

/** Judge an asset (ADR 0945 D3): deterministic stage A for the mode, then the
 *  stage-B vision judge when the asset depicts a product and the tenant has a
 *  vision provider. Never `pass` without evidence: a mode stage A cannot
 *  check, or an edit/animate result with no judge, is `needs_review`. A judge
 *  that stays invalid after its one repair throws `fidelity_judge_invalid`
 *  (no verdict is stored). */
export async function checkFidelity(tenantId: string, orgId: string, assetId: string, opts: { runId?: string; maskAssetId?: string; signal?: AbortSignal } = {}): Promise<FidelityVerdict> {
  const asset = await getAsset(tenantId, orgId, assetId);
  if (!asset) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId });
  const g = asset.lineage?.grounding;
  if (!g) throw new OpenwopError('validation_error', 'This asset has no generation record, so there is nothing to check it against.', 422, { assetId });
  const { base64: candidateB64, sha256: assetSha256 } = await bytesOf(tenantId, asset);

  const checks: FidelityCheck[] = [];
  let stage: StageResult;
  if (g.mode === 'composite') stage = await judgeComposite(tenantId, orgId, asset, g, candidateB64, checks);
  else if (g.mode === 'edit') stage = await judgeEdit(tenantId, orgId, asset, g, candidateB64, opts.maskAssetId, checks);
  else {
    checks.push({ id: 'mode', status: 'not_applicable', detail: `Mode "${g.mode}" has no deterministic check in this ruleset.` });
    stage = 'needs_review';
  }

  // Stage B — only when stage A has not already failed (a fail is final; the
  // judge can add failures, never remove one).
  let judge: FidelityVerdict['judge'];
  let judgeVerdict: StageResult | 'absent' = 'absent';
  if (stage !== 'fail' && g.productId) {
    const ran = await runJudgeFor(tenantId, orgId, g.productId, asset, candidateB64, checks, opts.signal);
    if (ran) { judge = ran.judge; judgeVerdict = ran.result; }
  }

  const outcome: FidelityOutcome = combineOutcome(stage, judgeVerdict, g.mode);

  const verdict: FidelityVerdict = {
    verdictId: verdictIdFor({ assetId, assetSha256, mode: g.mode, rulesetVersion: FIDELITY_RULESET_VERSION, sources: g.sources, outcome, checks, ...(judge ? { judge, invocation: opts.runId ?? randomUUID() } : {}) }),
    tenantId, orgId, assetId, assetSha256,
    mode: g.mode,
    ...(g.productId ? { productId: g.productId } : {}),
    sources: g.sources,
    checks,
    ...(judge ? { judge } : {}),
    outcome,
    rulesetVersion: FIDELITY_RULESET_VERSION,
    checkedAt: new Date().toISOString(),
    ...(opts.runId ? { runId: opts.runId } : {}),
  };
  const stored = await recordVerdict(verdict);
  await setGroundingFidelity(tenantId, orgId, assetId, { verdictId: stored.verdictId, outcome: stored.outcome, rulesetVersion: stored.rulesetVersion });
  return stored;
}

type StageResult = FidelityOutcome;
type Grounding = NonNullable<NonNullable<MediaAsset['lineage']>['grounding']>;

/** Up to this many of the product's photos go to the judge as SOURCE images. */
const JUDGE_MAX_SOURCES = 3;

/** Stage B. Returns null (with a not_applicable check) when no judge can run. */
async function runJudgeFor(tenantId: string, orgId: string, productId: string, asset: MediaAsset, candidateB64: string, checks: FidelityCheck[], signal?: AbortSignal): Promise<{ judge: NonNullable<FidelityVerdict['judge']>; result: StageResult } | null> {
  const described = await resolveHeadlessAiDescribed(tenantId, 'image', { featureId: 'creative-briefs' });
  if (!described) {
    checks.push({ id: 'judge', status: 'not_applicable', detail: 'No vision-capable AI provider is configured, so the model check did not run.' });
    return null;
  }
  const sources: JudgeImage[] = [];
  const productSources = await resolveProductMedia({ tenantId, orgId, productId }).catch(() => [] as ProductSource[]);
  for (const ps of productSources.slice(0, JUDGE_MAX_SOURCES)) {
    const a = await getAsset(tenantId, orgId, ps.assetId);
    if (!a || !isRasterisable(a.contentType)) continue;
    const b = await bytesOf(tenantId, a).catch(() => null);
    if (b) sources.push({ mimeType: a.contentType, dataBase64: b.base64 });
  }
  if (sources.length === 0) {
    checks.push({ id: 'judge', status: 'not_applicable', detail: 'None of the product\'s photos could be read, so the model check did not run.' });
    return null;
  }
  let out;
  try {
    out = await runFidelityJudge(described.dispatch, { sources, candidate: { mimeType: asset.contentType, dataBase64: candidateB64 }, ...(signal ? { signal } : {}) });
  } catch (err) {
    // An invalid ANSWER is a typed failure; a provider that did not answer is
    // an unavailable judge (needs_review in edit/animate), not a node crash.
    if (err instanceof OpenwopError && err.code === 'fidelity_judge_invalid') throw err;
    checks.push({ id: 'judge', status: 'not_applicable', detail: 'The vision provider did not answer, so the model check did not complete.' });
    return null;
  }
  const { outcome: result, critical, review } = judgeOutcome(out.results);
  checks.push({
    id: 'judge',
    status: result === 'fail' ? 'fail' : 'pass',
    detail: critical.length ? `The model found a mismatch on ${critical.join(', ')}.`
      : review.length ? `The model could not confirm ${review.join(', ')}.` : 'The model found the product matches on every attribute.',
  });
  return { judge: { provider: described.provider, ...(described.model ? { model: described.model } : {}), repaired: out.repaired, results: out.results }, result };
}

/** Edit mode (D2): the source photo with only its surroundings repainted under
 *  a protection mask built from the product's cut-out. Stage A compares the
 *  source and the result inside that mask — only when their geometry matches
 *  (a reframed or resized result is an aspect FAIL, not a guess). */
async function judgeEdit(tenantId: string, orgId: string, asset: MediaAsset, g: Grounding, candidateB64: string, maskAssetId: string | undefined, checks: FidelityCheck[]): Promise<StageResult> {
  const src = g.sources[0];
  if (!src) {
    checks.push({ id: 'source_product', status: 'fail', detail: 'The edit records no source photo.' });
    return 'fail';
  }
  if (g.productId) {
    const sources = await resolveProductMedia({ tenantId, orgId, productId: g.productId }).catch(() => [] as ProductSource[]);
    const ok = sources.some((s) => s.sha256 === src.sha256);
    checks.push({ id: 'source_product', status: ok ? 'pass' : 'fail', detail: ok ? 'The edited photo is one of this product\'s photos.' : 'The edited photo is not one of this product\'s current photos.' });
    if (!ok) return 'fail';
  }
  if (!maskAssetId) {
    checks.push({ id: 'dhash', status: 'not_applicable', detail: 'No protection mask was given, so the product region cannot be compared pixel by pixel.' });
    return 'needs_review';
  }
  const cutout = await getAsset(tenantId, orgId, maskAssetId);
  const cg = cutout?.lineage?.grounding;
  if (!cutout || !cg || cg.mode !== 'edit' || cg.op !== 'background-remove' || !cg.sources.some((s) => s.sha256 === src.sha256)) {
    checks.push({ id: 'byte_identity', status: 'fail', detail: 'The mask is not a background-removed copy of the photo that was edited.' });
    return 'fail';
  }
  const source = await getAsset(tenantId, orgId, src.assetId);
  const sourceBytes = source ? await bytesOf(tenantId, source).catch(() => null) : null;
  if (!source || !sourceBytes || sourceBytes.sha256 !== src.sha256) {
    checks.push({ id: 'byte_identity', status: 'not_applicable', detail: 'The source photo is gone or changed, so the product region cannot be re-checked.' });
    return 'needs_review';
  }
  const cutoutBytes = await bytesOf(tenantId, cutout);
  const sz = imageSize(Buffer.from(sourceBytes.base64, 'base64'));
  const cz = imageSize(Buffer.from(candidateB64, 'base64'));
  const drift = sz && cz ? Math.abs(sz.w / sz.h - cz.w / cz.h) / (sz.w / sz.h) : 1;
  const aspectOk = drift <= EDIT_ASPECT_TOLERANCE;
  checks.push({ id: 'aspect', status: aspectOk ? 'pass' : 'fail', value: Math.round(drift * 1000) / 1000, threshold: EDIT_ASPECT_TOLERANCE, detail: aspectOk ? 'The result keeps the source photo\'s proportions.' : 'The result was reframed or resized, so the product cannot be shown unchanged.' });
  if (!aspectOk) return 'fail';
  if (![source, cutout, asset].every((a) => isRasterisable(a.contentType))) {
    checks.push({ id: 'dhash', status: 'not_applicable', detail: 'The images cannot be sampled for a pixel comparison.' });
    return 'needs_review';
  }
  const grid = STAGE_A_RULES.grid;
  const s = rasteriseFull(source.contentType, sourceBytes.base64, grid);
  const c = rasteriseFull(asset.contentType, candidateB64, grid);
  const m = rasteriseFull(cutout.contentType, cutoutBytes.base64, grid);
  const stageA = runStageA(s, c, productMask(m, { w: grid, h: grid }));
  checks.push(...stageA);
  return stageA.every((x) => x.status !== 'fail') ? 'pass' : 'fail';
}

/** Max relative aspect-ratio drift between the source photo and an edit. */
const EDIT_ASPECT_TOLERANCE = 0.02;

/** ADR 0945 D2 — the provider-encoded protection mask for an edit of this
 *  product photo, at the photo's natural size. The bytes stay in the node. */
export async function protectionMask(tenantId: string, orgId: string, productId: string, cutoutAssetId: string, provider: string): Promise<{ maskBase64: string; width: number; height: number; sourceAssetId: string }> {
  // ADR 0945 Q1 — edit mode needs this client's opt-in; the mask is edit mode's only door.
  await assertEditModeEnabled(tenantId, orgId);
  const { cutout, source } = await verifyCutout(tenantId, orgId, productId, cutoutAssetId);
  const sourceAsset = await getAsset(tenantId, orgId, source.assetId);
  if (!sourceAsset) throw new OpenwopError('product_media_unresolved', 'The product photo is no longer in the media library.', 422, { productId });
  const sz = imageSize(Buffer.from((await bytesOf(tenantId, sourceAsset)).base64, 'base64'));
  if (!sz) throw new OpenwopError('validation_error', 'The product photo\'s size cannot be read.', 422, { productId });
  const cut = await bytesOf(tenantId, cutout);
  const encoding = provider === 'openai' ? 'openai' : 'replicate';
  return { maskBase64: protectionMaskPng(cutout.contentType, cut.base64, sz, encoding), width: sz.w, height: sz.h, sourceAssetId: source.assetId };
}

async function judgeComposite(tenantId: string, orgId: string, asset: MediaAsset, g: Grounding, candidateB64: string, checks: FidelityCheck[]): Promise<StageResult> {
  const cf = g.composedFrom;
  const render = cf?.briefId ? await getRender(tenantId, orgId, cf.briefId, cf.renderId) : null;
  const template = render ? getTemplate(render.templateId) : undefined;
  const layer = render?.layerAssets.product;
  if (!render || !template || !layer) {
    checks.push({ id: 'byte_identity', status: 'not_applicable', detail: 'The render record that placed the product is gone, so the placement cannot be re-checked.' });
    return 'needs_review';
  }
  // By construction: the product layer's recorded hash must be the cut-out's
  // bytes as they are now, and that cut-out must be one of the product's.
  const cutout = await getAsset(tenantId, orgId, layer.mediaAssetId);
  const cutoutBytes = cutout ? await bytesOf(tenantId, cutout).catch(() => null) : null;
  const identical = !!cutoutBytes && cutoutBytes.sha256 === layer.sha256;
  checks.push({ id: 'byte_identity', status: identical ? 'pass' : 'fail', detail: identical ? 'The product layer is the cut-out\'s exact bytes.' : 'The product layer\'s bytes do not match the cut-out the render recorded.' });
  let productOk = false;
  if (cutout && g.productId) {
    productOk = await verifyCutout(tenantId, orgId, g.productId, cutout.assetId).then(() => true, () => false);
  }
  checks.push({ id: 'source_product', status: productOk ? 'pass' : 'fail', detail: productOk ? 'The cut-out is a background-removed copy of one of this product\'s photos.' : 'The product layer is not a background-removed copy of this product\'s photos.' });
  checks.push({ id: 'aspect', status: 'pass', detail: 'By construction: the renderer places the product with a contain fit, which preserves its proportions.' });
  if (!identical || !productOk || !cutout || !cutoutBytes) return 'fail';

  const slot = imageLayerSlot(template, 'product', render.overrides);
  if (!slot || !isRasterisable(cutout.contentType) || !isRasterisable(asset.contentType)) {
    checks.push({ id: 'dhash', status: 'not_applicable', detail: 'The images cannot be sampled for a pixel comparison.' });
    return 'needs_review';
  }
  const grid = STAGE_A_RULES.grid;
  const source = rasteriseIntoSlot(cutout.contentType, cutoutBytes.base64, slot.box, grid);
  const candidate = rasteriseCrop(asset.contentType, candidateB64, { w: template.width, h: template.height }, slot.box, grid);
  const stageA = runStageA(source, candidate, productMask(source, { w: slot.box.w, h: slot.box.h, radiusPx: slot.radiusPx }));
  checks.push(...stageA);
  return stageA.every((c) => c.status !== 'fail') ? 'pass' : 'fail';
}
