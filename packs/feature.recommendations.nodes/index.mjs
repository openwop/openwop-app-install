/**
 * feature.recommendations.nodes — MERCH-A nodes over the `ctx.features.recommendations`
 * surface (ADR 0273 / ADR 0058). Both nodes are role:"action": `resolve` reads the
 * MUTABLE recs cache/catalog so its output is RECORDED (replay/:fork read the recorded
 * result — a role:"read" would re-execute and drift, ADR 0273 ruling 7); `placement-upsert`
 * is a write. Pure-JS, Node-20 stdlib only. Calls the SAME service the REST route calls.
 */
function ensureReco(ctx) {
  const s = ctx.features && ctx.features.recommendations;
  if (!s || typeof s.resolve !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.recommendations — the recommendations feature must be composed (ADR 0273)'), { code: 'host_capability_missing', capability: 'host.recommendations' });
  }
  return s;
}
const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });

export async function resolve(ctx) {
  const s = ensureReco(ctx);
  const i = merged(ctx);
  if (!i.orgId || !i.slot) throw Object.assign(new Error('resolve requires `orgId` and `slot`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.resolve(i) };
}

export async function placementUpsert(ctx) {
  const s = ensureReco(ctx);
  const i = merged(ctx);
  if (!i.orgId || !i.slot || !i.source) throw Object.assign(new Error('placement-upsert requires `orgId`, `slot`, `source`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.upsertPlacement(i) };
}

export const nodes = {
  'feature.recommendations.nodes.resolve': resolve,
  'feature.recommendations.nodes.placement-upsert': placementUpsert,
};
export default nodes;
