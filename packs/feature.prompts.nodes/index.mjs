/**
 * feature.prompts.nodes — prompt-library reads over ctx.features.prompts (NP-HOLE-PROMPTS-1).
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

export async function listLibrary(ctx) {
  const p = ensure(ctx, 'prompts', 'listLibrary');
  const out = await p.listLibrary({ orgId: (ctx.inputs ?? {}).orgId });
  return { status: 'success', outputs: { entries: out.entries ?? [] } };
}
export async function getEntry(ctx) {
  const p = ensure(ctx, 'prompts', 'getEntry');
  const i = ctx.inputs ?? {};
  const out = await p.getEntry({ orgId: i.orgId, entryId: i.entryId });
  return { status: 'success', outputs: { entry: out.entry ?? null } };
}
export async function renderEntry(ctx) {
  const p = ensure(ctx, 'prompts', 'renderEntry');
  const i = ctx.inputs ?? {};
  const out = await p.renderEntry({ orgId: i.orgId, entryId: i.entryId, variables: i.variables ?? {} });
  return { status: 'success', outputs: out };
}
export const nodes = {
  'feature.prompts.nodes.list-library': listLibrary,
  'feature.prompts.nodes.get-entry': getEntry,
  'feature.prompts.nodes.render-entry': renderEntry,
};
export default nodes;
