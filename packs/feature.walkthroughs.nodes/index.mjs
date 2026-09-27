/**
 * feature.walkthroughs.nodes — ctx.features.walkthroughs reads (NP-WALK-1).
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

export async function list(ctx) {
  const w = ensure(ctx, 'walkthroughs', 'listWalkthroughs');
  const out = await w.listWalkthroughs({});
  return { status: 'success', outputs: { walkthroughs: out.walkthroughs ?? [] } };
}
export async function progress(ctx) {
  const w = ensure(ctx, 'walkthroughs', 'walkthroughProgress');
  const out = await w.walkthroughProgress({});
  return { status: 'success', outputs: { progress: out.progress ?? [] } };
}
export const nodes = {
  'feature.walkthroughs.nodes.list': list,
  'feature.walkthroughs.nodes.progress': progress,
};
export default nodes;
