/**
 * feature.promotions.nodes — MERCH-B nodes over `ctx.features.promotions` (ADR 0274 /
 * ADR 0058). `create` is money-moving, so an agent-authored promotion lands PROPOSED
 * (the surface forces active:false) — a human activates it. All role:"action" (recorded).
 * Pure-JS, Node-20 stdlib only. Calls the SAME service the REST route calls.
 */
function ensurePromo(ctx) {
  const s = ctx.features && ctx.features.promotions;
  if (!s || typeof s.listActive !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.promotions — the promotions feature must be composed (ADR 0274)'), { code: 'host_capability_missing', capability: 'host.promotions' });
  }
  return s;
}
const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });

export async function listActive(ctx) {
  const s = ensurePromo(ctx);
  const i = merged(ctx);
  if (!i.orgId) throw Object.assign(new Error('list-active requires `orgId`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.listActive(i) };
}

export async function applyPreview(ctx) {
  const s = ensurePromo(ctx);
  const i = merged(ctx);
  if (!i.orgId) throw Object.assign(new Error('apply-preview requires `orgId`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.applyPreview(i) };
}

export async function create(ctx) {
  const s = ensurePromo(ctx);
  const i = merged(ctx);
  if (!i.orgId || !i.name || !i.type || !i.reward) throw Object.assign(new Error('create requires `orgId`, `name`, `type`, `reward`'), { code: 'validation_error' });
  return { status: 'success', outputs: await s.create(i) };
}

export const nodes = {
  'feature.promotions.nodes.list-active': listActive,
  'feature.promotions.nodes.apply-preview': applyPreview,
  'feature.promotions.nodes.create': create,
};
export default nodes;
