/**
 * feature.creative-video.nodes — AI avatar video (ADR 0404 §b). Compose
 * ctx.features['creative-video']. role:"action". Pure-JS, Node-20 stdlib only.
 * The generate node's output is the MEDIA ASSET ID (replay returns it, never
 * regenerates); a `pending` result is resolved by the status node.
 */

function ensureVideo(ctx) {
  const v = ctx.features && ctx.features['creative-video'];
  if (!v || typeof v.generateVideo !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['creative-video'] (ADR 0404) — the feature must be composed"),
      { code: 'host_capability_missing', capability: 'host.sample.creative-video' },
    );
  }
  return v;
}

const str = (v) => (typeof v === 'string' ? v : '');

export async function generate(ctx) {
  const v = ensureVideo(ctx);
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const script = str(i.script);
  const avatarId = str(i.avatarId);
  if (!orgId || !script || !avatarId) {
    return { status: 'failed', error: { code: 'validation_error', message: 'orgId, script, and avatarId are required.' } };
  }
  const out = await v.generateVideo({ orgId, script, avatarId, ...(str(i.voiceId) ? { voiceId: str(i.voiceId) } : {}) });
  if (out && out.status === 'failed') {
    return { status: 'failed', error: { code: 'video_generation_failed', message: `Video generation failed: ${out.error || 'unknown'}` }, outputs: out };
  }
  // 'completed' (asset id present) or 'pending' — both are successful node runs;
  // consumers branch on outputs.status.
  return { status: 'success', outputs: out };
}

export async function textToVideo(ctx) {
  const v = ensureVideo(ctx);
  if (typeof v.textToVideo !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['creative-video'].textToVideo unavailable (creative-video.t2v sub-toggle off?)." } };
  }
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const prompt = str(i.prompt);
  if (!orgId || !prompt) {
    return { status: 'failed', error: { code: 'validation_error', message: 'orgId and prompt are required.' } };
  }
  const durationSec = typeof i.durationSec === 'number' ? i.durationSec : undefined;
  const out = await v.textToVideo({ orgId, prompt, ...(str(i.model) ? { model: str(i.model) } : {}), ...(durationSec ? { durationSec } : {}) });
  if (out && out.status === 'failed') {
    return { status: 'failed', error: { code: 'video_generation_failed', message: `Text-to-video failed: ${out.error || 'unknown'}` }, outputs: out };
  }
  return { status: 'success', outputs: out };
}

/**
 * ADR 0945 D7 — animate a checked product shot (a composite or edit with a
 * passing verdict) or one of the product's own photos. The host refuses any
 * other still (`product_depiction_ungrounded`). Every product video is
 * `needs_review`: frames cannot be sampled on this host yet, so the publish
 * gate holds it for a person. `pending` is resolved by the status node.
 */
export async function imageToVideo(ctx) {
  const v = ensureVideo(ctx);
  if (typeof v.imageToVideo !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['creative-video'].imageToVideo unavailable." } };
  }
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const sourceAssetId = str(i.sourceAssetId);
  const prompt = str(i.prompt);
  if (!orgId || !sourceAssetId || !prompt) {
    return { status: 'failed', error: { code: 'validation_error', message: 'orgId, sourceAssetId, and prompt are required.' } };
  }
  const durationSec = typeof i.durationSec === 'number' ? i.durationSec : undefined;
  const out = await v.imageToVideo({ orgId, sourceAssetId, prompt, ...(str(i.productId) ? { productId: str(i.productId) } : {}), ...(str(i.model) ? { model: str(i.model) } : {}), ...(durationSec ? { durationSec } : {}) });
  if (out && out.status === 'failed') {
    return { status: 'failed', error: { code: 'video_generation_failed', message: `Image-to-video failed: ${out.error || 'unknown'}` }, outputs: out };
  }
  return { status: 'success', outputs: { ...out, ...(out && out.status === 'completed' ? { outcome: 'needs_review' } : {}) } };
}

export async function status(ctx) {
  const v = ensureVideo(ctx);
  if (typeof v.getVideoStatus !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['creative-video'].getVideoStatus unavailable." } };
  }
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  const jobId = str(i.jobId);
  if (!orgId || !jobId) return { status: 'failed', error: { code: 'validation_error', message: 'orgId and jobId are required.' } };
  const out = await v.getVideoStatus({ orgId, jobId });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.creative-video.nodes.generate': generate,
  'feature.creative-video.nodes.text-to-video': textToVideo,
  'feature.creative-video.nodes.image-to-video': imageToVideo,
  'feature.creative-video.nodes.status': status,
};

export default nodes;
