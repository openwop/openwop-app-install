/**
 * feature.media.nodes — ctx.features.media reads (node-pack audit 2026-07-18).
 *
 * `select` is the ADR 0352 P4 deterministic weighted image selection — pure
 * ranking over the org's library, but role:action so the engine records the
 * result and replay/fork read the recorded selection (the library mutates
 * between runs). The write verb `createAssetFromServeUrl` stays consumer-pack
 * covered (feature.campaign-channels.nodes render-concepts) — not duplicated
 * here.
 */
function ensure(ctx, method) {
  const s = ctx.features && ctx.features.media;
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features.media.${method} — the Media feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: 'host.sample.media' },
    );
  }
  return s;
}
function str(v) { return typeof v === 'string' ? v : ''; }

export async function select(ctx) {
  const media = ensure(ctx, 'select');
  const i = ctx.inputs ?? {};
  const out = await media.select({
    orgId: str(i.orgId),
    ...(str(i.product) ? { product: str(i.product) } : {}),
    ...(str(i.industry) ? { industry: str(i.industry) } : {}),
    ...(str(i.useCase) ? { useCase: str(i.useCase) } : {}),
    ...(Array.isArray(i.personaIds) ? { personaIds: i.personaIds.filter((x) => typeof x === 'string') } : {}),
    ...(str(i.collectionId) ? { collectionId: str(i.collectionId) } : {}),
    ...(typeof i.limit === 'number' ? { limit: i.limit } : {}),
  });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.media.nodes.select': select,
};
export default nodes;
