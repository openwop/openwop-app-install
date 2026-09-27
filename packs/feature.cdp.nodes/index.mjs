/**
 * feature.cdp.nodes — identity-resolution read over ctx.features.cdp (NP-HOLE-CDP-1).
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

export async function resolveIdentity(ctx) {
  const cdp = ensure(ctx, 'cdp', 'resolveIdentity');
  const i = ctx.inputs ?? {};
  const out = await cdp.resolveIdentity({ type: i.type, value: i.value });
  return { status: 'success', outputs: { resolved: out.resolved ?? null, masked: out.masked === true } };
}
export const nodes = { 'feature.cdp.nodes.resolve-identity': resolveIdentity };
export default nodes;
