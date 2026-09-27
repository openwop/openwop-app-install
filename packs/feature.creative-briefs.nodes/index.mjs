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

export const nodes = {
  'feature.creative-briefs.nodes.create': create,
  'feature.creative-briefs.nodes.list': list,
  'feature.creative-briefs.nodes.get': get,
  'feature.creative-briefs.nodes.render': render,
  'feature.creative-briefs.nodes.render-variants': renderVariants,
  'feature.creative-briefs.nodes.list-render-templates': listRenderTemplates,
  'feature.creative-briefs.nodes.generate-reel': generateReel,
};
export default nodes;
