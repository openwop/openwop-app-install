/**
 * feature.funnels.nodes — Funnel A nodes over `ctx.features.funnels` (ADR 0294 /
 * ADR 0058). Writes author DRAFT state only — publishing is human (public-surface
 * change). All role:"action" (recorded). Pure-JS, Node-20 stdlib only. Calls the
 * SAME service functions the REST routes call.
 */
function ensureFunnels(ctx) {
  const s = ctx.features && ctx.features.funnels;
  if (!s || typeof s.list !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.funnels — the funnels feature must be composed (ADR 0294)'), { code: 'host_capability_missing', capability: 'host.funnels' });
  }
  return s;
}
const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });
const need = (i, keys, node) => {
  for (const k of keys) if (!i[k]) throw Object.assign(new Error(`${node} requires \`${k}\``), { code: 'validation_error' });
};

export async function list(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId'], 'list');
  return { status: 'success', outputs: await s.list(i) };
}

export async function get(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId'], 'get');
  return { status: 'success', outputs: await s.get(i) };
}

export async function create(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'name'], 'create');
  return { status: 'success', outputs: await s.create(i) };
}

export async function setSteps(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId', 'steps'], 'set-steps');
  return { status: 'success', outputs: await s.setSteps(i) };
}

export async function stepStats(ctx) {
  const s = ensureFunnels(ctx); const i = merged(ctx);
  need(i, ['orgId', 'funnelId'], 'step-stats');
  return { status: 'success', outputs: await s.stepStats(i) };
}

export const nodes = {
  'feature.funnels.nodes.list': list,
  'feature.funnels.nodes.get': get,
  'feature.funnels.nodes.create': create,
  'feature.funnels.nodes.set-steps': setSteps,
  'feature.funnels.nodes.step-stats': stepStats,
};
export default nodes;
