/**
 * feature.creative-briefs.nodes — the full ctx.features.creative-briefs surface
 * (NP-HOLE-CB-1). The create write calls the same service path as HTTP.
 */
function ensure(ctx, id, method) {
  const s = ctx.features && ctx.features[id];
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features.${id}.${method} — the feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: `host.sample.${id}` },
    );
  }
  return s;
}

export async function create(ctx) {
  const cb = ensure(ctx, 'creative-briefs', 'create');
  const out = await cb.create({ ...(ctx.inputs ?? {}) });
  return { status: 'success', outputs: { brief: out.brief ?? null } };
}
export async function list(ctx) {
  const cb = ensure(ctx, 'creative-briefs', 'list');
  const out = await cb.list({ orgId: (ctx.inputs ?? {}).orgId });
  return { status: 'success', outputs: { briefs: out.briefs ?? [] } };
}
export async function get(ctx) {
  const cb = ensure(ctx, 'creative-briefs', 'get');
  const i = ctx.inputs ?? {};
  const out = await cb.get({ orgId: i.orgId, briefId: i.briefId });
  return { status: 'success', outputs: out };
}
// ADR 0399 — deterministic ad-layout renders. Bytes never cross the node
// result boundary: the surface stores the PNG as a Media asset host-side and
// the node returns ids + advisory warnings (the ADR 0115 image-gen precedent).
export async function render(ctx) {
  const cb = ensure(ctx, 'creative-briefs', 'render');
  const out = await cb.render({ ...(ctx.inputs ?? {}) });
  return { status: 'success', outputs: { render: out.render ?? null, mediaAssetId: out.mediaAssetId ?? null, warnings: out.warnings ?? [] } };
}
export async function renderVariants(ctx) {
  const cb = ensure(ctx, 'creative-briefs', 'renderVariants');
  const out = await cb.renderVariants({ ...(ctx.inputs ?? {}) });
  return { status: 'success', outputs: { renders: out.renders ?? [], failures: out.failures ?? [] } };
}
export async function listRenderTemplates(ctx) {
  const cb = ensure(ctx, 'creative-briefs', 'listRenderTemplates');
  const out = await cb.listRenderTemplates({});
  return { status: 'success', outputs: { templates: out.templates ?? [] } };
}
/**
 * ADR 0411 P3 — Generate reel: derive a text-to-video prompt from the brief,
 * generate the video via the host cap (the async lane — host hides polling,
 * honors cancel), promote the generated video (a host serve URL) to a durable
 * Media asset, and store it as a reel render. Deterministic renderId
 * (crender:${runId}:${nodeId}) ⇒ a re-run/:fork/replay converges, never
 * duplicates. Rides ctx.callVideoGenerator — no 4th video generator (ADR 0411
 * P3 architect ruling).
 */
export async function generateReel(ctx) {
  if (typeof ctx.callVideoGenerator !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callVideoGenerator — aiProviders.videoGeneration must be wired'),
      { code: 'host_capability_missing', capability: 'aiProviders.videoGeneration' },
    );
  }
  const i = ctx.inputs ?? {};
  // 1. Derive the prompt closed-world from the brief.
  const cb = ensure(ctx, 'creative-briefs', 'reelPrompt');
  const { prompt } = await cb.reelPrompt({ orgId: i.orgId, briefId: i.briefId, ...(i.directionIndex != null ? { directionIndex: i.directionIndex } : {}) });
  // 2. Generate the video (recorded → replay reads the result verbatim, never re-calls).
  const gen = await ctx.callVideoGenerator({
    prompt,
    ...(i.aspectRatio ? { aspectRatio: i.aspectRatio } : {}),
    ...(i.durationSeconds != null ? { durationSeconds: i.durationSeconds } : {}),
    ...(i.credentialRef ? { credentialRef: i.credentialRef } : {}),
    ...(i.provider ? { provider: i.provider } : {}),
    ...(i.model ? { model: i.model } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const video = gen.video ?? gen;
  // 3. Promote the generated video (a host serve URL) to a DURABLE Media asset —
  //    SSRF-safe (createAssetFromServeUrl takes a host serve token, never fetches
  //    an arbitrary URL) + hash-deduped + capacity-gated.
  const media = ensure(ctx, 'media', 'createAssetFromServeUrl');
  const asset = await media.createAssetFromServeUrl({ orgId: i.orgId, url: video.url, name: `reel-${i.briefId}.mp4` });
  // 4. Store the reel render, id-preserving for replay/fork.
  const store = ensure(ctx, 'creative-briefs', 'storeReel');
  const { render } = await store.storeReel({
    orgId: i.orgId, briefId: i.briefId,
    videoAssetId: asset.assetId,
    prompt,
    renderId: `crender:${ctx.runId}:${ctx.nodeId}`,
    ...(i.aspectRatio ? { aspectRatio: i.aspectRatio } : {}),
    ...(video.durationSeconds != null ? { durationSeconds: video.durationSeconds } : {}),
    ...(i.directionIndex != null ? { directionIndex: i.directionIndex } : {}),
    ...(video.metadata && video.metadata.provider ? { provider: video.metadata.provider } : {}),
  });
  return { status: 'success', outputs: { render, mediaAssetId: asset.assetId } };
}

/**
 * ADR 0945 P1 — compose a PRODUCT SHOT (composite mode). The product is never
 * drawn by a model: its own catalog photo is background-removed by the
 * recorded image-edit call, then placed — copied, only scaled — on a scene by
 * the deterministic renderer. The scene is either an existing asset
 * (`backgroundAssetId`) or generated from `scenePrompt`, which is told to leave
 * the product out. The result is checked against the source (stage A); a
 * `fail` ends the node with `fidelity_failed` (a composite re-render would
 * reproduce the same pixels, so there is nothing to repair), `needs_review`
 * succeeds and carries the outcome for a reviewer gate.
 * The source's BYTES pass through this node's memory only; outputs are ids.
 */
const SCENE_SUFFIX = ' Empty scene for product placement: no product, no packaging, no logos, no text, nothing in the centre foreground.';
export async function composeProductShot(ctx) {
  const i = ctx.inputs ?? {};
  const cb = ensure(ctx, 'creative-briefs', 'composeProductShot');
  const media = ensure(ctx, 'media', 'createAssetFromServeUrl');
  if (!i.backgroundAssetId && !(typeof i.scenePrompt === 'string' && i.scenePrompt.trim())) {
    return { status: 'failed', error: { code: 'validation_error', message: 'Give a backgroundAssetId or a scenePrompt.' } };
  }
  const editor = ctx.callImageEditor ?? (ctx.aiProviders && ctx.aiProviders.callImageEditor);
  if (typeof editor !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.callImageEditor — aiProviders.imageEdit must be wired'), { code: 'host_capability_missing', capability: 'aiProviders.imageEdit' });
  }
  // 1. The product's own photo (bytes stay in this node).
  const src = await cb.productShotSource({ orgId: i.orgId, productId: i.productId, ...(i.sourceAssetId ? { sourceAssetId: i.sourceAssetId } : {}) });
  // 2. Cut it out (recorded; the host stamps the input hash on the result).
  const cut = await editor.call(ctx, {
    imageBase64: src.contentBase64, mimeType: src.mimeType, op: 'background-remove',
    ...(i.editProvider ? { provider: i.editProvider } : {}),
    ...(i.editModel ? { model: i.editModel } : {}),
    ...(i.credentialRef ? { credentialRef: i.credentialRef } : {}),
  });
  const cutImg = cut && Array.isArray(cut.images) ? cut.images[0] : null;
  if (!cutImg || typeof cutImg.url !== 'string') return { status: 'failed', error: { code: 'host_capability_missing', message: 'Background removal returned no image.' } };
  const cutout = await media.createAssetFromServeUrl({ orgId: i.orgId, url: cutImg.url, name: `Product cut-out — ${i.productId}`, tags: ['product', 'cut-out'], productId: i.productId });
  // 3. The scene (product-less).
  let backgroundAssetId = i.backgroundAssetId;
  if (!backgroundAssetId) {
    const gen = ctx.callImageGenerator ?? (ctx.aiProviders && ctx.aiProviders.callImageGenerator);
    if (typeof gen !== 'function') {
      throw Object.assign(new Error('host does not expose ctx.callImageGenerator — aiProviders.imageGeneration must be wired'), { code: 'host_capability_missing', capability: 'aiProviders.imageGeneration' });
    }
    const prompt = `${i.scenePrompt.trim()}${SCENE_SUFFIX}`.slice(0, 2000);
    const scene = await gen.call(ctx, {
      prompt, n: 1,
      ...(i.provider ? { provider: i.provider } : {}),
      ...(i.model ? { model: i.model } : {}),
      ...(i.size ? { size: i.size } : {}),
      ...(i.credentialRef ? { credentialRef: i.credentialRef } : {}),
    });
    const img = scene && Array.isArray(scene.images) ? scene.images[0] : null;
    if (!img || typeof img.url !== 'string') return { status: 'failed', error: { code: 'host_capability_missing', message: 'Scene generation returned no image.' } };
    const bg = await media.createAssetFromServeUrl({ orgId: i.orgId, url: img.url, name: 'Product scene', tags: ['scene'], lineage: { generatedBy: 'ai', prompt } });
    backgroundAssetId = bg.assetId;
  }
  // 4. Compose (the host re-verifies the cut-out IS this product).
  const composed = await cb.composeProductShot({
    orgId: i.orgId, productId: i.productId, briefId: i.briefId, templateId: i.templateId,
    cutoutAssetId: cutout.assetId, backgroundAssetId,
    ...(i.directionIndex != null ? { directionIndex: i.directionIndex } : {}),
    ...(i.copy ? { copy: i.copy } : {}),
  });
  // 5. Judge it.
  const { verdict } = await cb.checkFidelity({ orgId: i.orgId, assetId: composed.mediaAssetId });
  const ids = { mediaAssetId: composed.mediaAssetId, renderId: composed.render && composed.render.renderId, cutoutAssetId: cutout.assetId, backgroundAssetId, sourceAssetId: src.assetId };
  if (verdict.outcome === 'fail') {
    return { status: 'failed', error: { code: 'fidelity_failed', message: `The composed shot does not match the product photo (verdict ${verdict.verdictId}).`, verdictId: verdict.verdictId, ...ids } };
  }
  return { status: 'success', outputs: { ...ids, verdictId: verdict.verdictId, outcome: verdict.outcome, warnings: composed.warnings ?? [] } };
}

/** ADR 0945 P1 — check a generated asset against its product source (stage A). */
export async function fidelityCheck(ctx) {
  const i = ctx.inputs ?? {};
  const cb = ensure(ctx, 'creative-briefs', 'checkFidelity');
  const { verdict } = await cb.checkFidelity({ orgId: i.orgId, assetId: i.assetId, ...(i.maskAssetId ? { maskAssetId: i.maskAssetId } : {}) });
  if (verdict.outcome === 'fail') {
    return { status: 'failed', error: { code: 'fidelity_failed', message: `Asset ${i.assetId} does not match its product photo (verdict ${verdict.verdictId}).`, verdictId: verdict.verdictId } };
  }
  return { status: 'success', outputs: { verdictId: verdict.verdictId, outcome: verdict.outcome, checks: verdict.checks } };
}

/**
 * ADR 0945 P2 — EDIT mode. The catalog photo itself is edited: only its
 * surroundings are repainted, under a protection mask built from the product's
 * own cut-out, so the product's pixels are meant to survive untouched. The
 * result is judged (stage A inside the mask + the vision judge). A `fail` gets
 * exactly ONE repair — the edit re-run with the mismatches as constraints; a
 * second `fail` ends the node with `fidelity_failed`. `needs_review` succeeds
 * and carries the outcome for a reviewer gate. Bytes stay in node memory.
 */
const KEEP_PRODUCT = ' Keep the product exactly as it is: same shape, colours, logo and label text. Change only the surroundings.';
export async function editProductScene(ctx) {
  const i = ctx.inputs ?? {};
  const cb = ensure(ctx, 'creative-briefs', 'protectionMask');
  const media = ensure(ctx, 'media', 'createAssetFromServeUrl');
  if (!(typeof i.prompt === 'string' && i.prompt.trim())) {
    return { status: 'failed', error: { code: 'validation_error', message: 'A scene prompt is required.' } };
  }
  const editor = ctx.callImageEditor ?? (ctx.aiProviders && ctx.aiProviders.callImageEditor);
  if (typeof editor !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.callImageEditor — aiProviders.imageEdit must be wired'), { code: 'host_capability_missing', capability: 'aiProviders.imageEdit' });
  }
  const provider = i.provider || 'replicate';
  const common = { ...(i.model ? { model: i.model } : {}), ...(i.credentialRef ? { credentialRef: i.credentialRef } : {}) };
  // `mode:'edit'` — the host refuses a client that has not opted into edit mode, before any spend.
  const src = await cb.productShotSource({ orgId: i.orgId, productId: i.productId, mode: 'edit', ...(i.sourceAssetId ? { sourceAssetId: i.sourceAssetId } : {}) });
  // 1. The cut-out, for the mask.
  // OpenAI has no background removal (IMAGE_OP_SUPPORT), so the cut-out
  // defaults to Replicate there; each provider takes its own credential.
  const cutoutProvider = i.cutoutProvider || (provider === 'openai' ? 'replicate' : provider);
  const cutoutCred = i.cutoutCredentialRef || (cutoutProvider === provider ? i.credentialRef : undefined);
  const cut = await editor.call(ctx, { imageBase64: src.contentBase64, mimeType: src.mimeType, op: 'background-remove', provider: cutoutProvider, ...(i.model && cutoutProvider === provider ? { model: i.model } : {}), ...(cutoutCred ? { credentialRef: cutoutCred } : {}) });
  const cutImg = cut && Array.isArray(cut.images) ? cut.images[0] : null;
  if (!cutImg || typeof cutImg.url !== 'string') return { status: 'failed', error: { code: 'host_capability_missing', message: 'Background removal returned no image.' } };
  const cutout = await media.createAssetFromServeUrl({ orgId: i.orgId, url: cutImg.url, name: `Product cut-out — ${i.productId}`, tags: ['product', 'cut-out'], productId: i.productId });
  const { maskBase64 } = await cb.protectionMask({ orgId: i.orgId, productId: i.productId, cutoutAssetId: cutout.assetId, provider });
  // 2. Edit, judge, and repair once.
  const attempt = async (prompt) => {
    const out = await editor.call(ctx, { imageBase64: src.contentBase64, mimeType: src.mimeType, op: 'inpaint', maskBase64, prompt, provider, ...common });
    const img = out && Array.isArray(out.images) ? out.images[0] : null;
    if (!img || typeof img.url !== 'string') return null;
    const asset = await media.createAssetFromServeUrl({ orgId: i.orgId, url: img.url, name: `Product scene — ${i.productId}`, tags: ['product', 'scene'], productId: i.productId });
    const { verdict } = await cb.checkFidelity({ orgId: i.orgId, assetId: asset.assetId, maskAssetId: cutout.assetId });
    return { asset, verdict };
  };
  const basePrompt = `${i.prompt.trim()}${KEEP_PRODUCT}`.slice(0, 2000);
  let r = await attempt(basePrompt);
  if (!r) return { status: 'failed', error: { code: 'host_capability_missing', message: 'The edit returned no image.' } };
  let repaired = false;
  if (r.verdict.outcome === 'fail') {
    const failed = r.verdict.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    const mism = (r.verdict.judge && r.verdict.judge.results || []).filter((x) => x.answer === 'mismatch').map((x) => x.attribute);
    const constraints = [...new Set([...mism, ...failed])].join(', ');
    const second = await attempt(`${basePrompt} The previous attempt changed the product (${constraints}); do not alter the product at all.`.slice(0, 2000));
    if (second) { r = second; repaired = true; }
  }
  const ids = { mediaAssetId: r.asset.assetId, cutoutAssetId: cutout.assetId, sourceAssetId: src.assetId, verdictId: r.verdict.verdictId, repaired };
  if (r.verdict.outcome === 'fail') {
    return { status: 'failed', error: { code: 'fidelity_failed', message: `The edited scene changed the product (verdict ${r.verdict.verdictId}).`, ...ids } };
  }
  return { status: 'success', outputs: { ...ids, outcome: r.verdict.outcome } };
}

export const nodes = {
  'feature.creative-briefs.nodes.create': create,
  'feature.creative-briefs.nodes.list': list,
  'feature.creative-briefs.nodes.get': get,
  'feature.creative-briefs.nodes.render': render,
  'feature.creative-briefs.nodes.render-variants': renderVariants,
  'feature.creative-briefs.nodes.list-render-templates': listRenderTemplates,
  'feature.creative-briefs.nodes.generate-reel': generateReel,
  'feature.creative-briefs.nodes.compose-product-shot': composeProductShot,
  'feature.creative-briefs.nodes.fidelity-check': fidelityCheck,
  'feature.creative-briefs.nodes.edit-product-scene': editProductScene,
};
export default nodes;
