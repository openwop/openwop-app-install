/**
 * feature.territories.nodes — Sales Territory Management nodes (ADR 0272 / ADR 0014).
 *
 * Seven role:"action" READ nodes over the `ctx.features.territories` surface:
 * list models (+ active), list a model's territories/rules/quotas, dry-run an
 * assignment preview, and compute attainment. Read-only by design — territory
 * writes are governed admin ops behind host:territories:manage HTTP routes, not
 * agent tool calls (the CRM ADR 0208 §2 stance).
 *
 * Each node reads the merged `{ ...ctx.config, ...ctx.inputs }` args shape (the
 * core.openwop.ai idiom) so the SAME node works from an agent tool call or a
 * chain-pack DAG. The surface enforces the tenant+org key (CTI-1); tenantId
 * comes from the run scope, never node args. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the territories surface, or fail with the canonical capability error. */
function ensure(ctx) {
  const t = ctx.features && ctx.features.territories;
  if (!t || typeof t.listModels !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.territories — the territories feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.territories' },
    );
  }
  return t;
}

const str = (v) => (typeof v === 'string' ? v : '');
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

export async function listModels(ctx) {
  const t = ensure(ctx);
  const out = await t.listModels({ orgId: str(args(ctx).orgId) });
  return { status: 'success', outputs: { models: out.models ?? [], activeModelId: out.activeModelId ?? null } };
}

export async function activeModel(ctx) {
  const t = ensure(ctx);
  const out = await t.activeModel({ orgId: str(args(ctx).orgId) });
  return { status: 'success', outputs: { activeModelId: out.activeModelId ?? null } };
}

export async function listTerritories(ctx) {
  const t = ensure(ctx);
  const i = args(ctx);
  const out = await t.listTerritories({ orgId: str(i.orgId), modelId: str(i.modelId) });
  return { status: 'success', outputs: { territories: out.territories ?? [] } };
}

export async function listRules(ctx) {
  const t = ensure(ctx);
  const i = args(ctx);
  const out = await t.listRules({ orgId: str(i.orgId), modelId: str(i.modelId) });
  return { status: 'success', outputs: { rules: out.rules ?? [] } };
}

export async function listQuotas(ctx) {
  const t = ensure(ctx);
  const i = args(ctx);
  const out = await t.listQuotas({ orgId: str(i.orgId), modelId: str(i.modelId), ...(str(i.period) ? { period: str(i.period) } : {}) });
  return { status: 'success', outputs: { quotas: out.quotas ?? [] } };
}

export async function preview(ctx) {
  const t = ensure(ctx);
  const i = args(ctx);
  const out = await t.previewModel({ orgId: str(i.orgId), modelId: str(i.modelId) });
  return { status: 'success', outputs: { summary: out.summary ?? null } };
}

export async function attainment(ctx) {
  const t = ensure(ctx);
  const i = args(ctx);
  const out = await t.attainment({ orgId: str(i.orgId), modelId: str(i.modelId), ...(str(i.period) ? { period: str(i.period) } : {}) });
  return { status: 'success', outputs: { period: out.period ?? null, territories: out.territories ?? [], unassigned: out.unassigned ?? null } };
}

/* ─── Governed writes (ADR 0272 A5) — the surface enforces the run owner's scope ─── */

export async function activateModel(ctx) {
  const t = ensure(ctx);
  if (typeof t.activateModel !== 'function') throw Object.assign(new Error('ctx.features.territories.activateModel not exposed'), { code: 'host_capability_missing', capability: 'host.sample.territories' });
  const i = args(ctx);
  const out = await t.activateModel({ orgId: str(i.orgId), modelId: str(i.modelId) });
  return { status: 'success', outputs: { success: out.success ?? true, model: out.model ?? null } };
}

export async function setQuota(ctx) {
  const t = ensure(ctx);
  if (typeof t.setQuota !== 'function') throw Object.assign(new Error('ctx.features.territories.setQuota not exposed'), { code: 'host_capability_missing', capability: 'host.sample.territories' });
  const i = args(ctx);
  const out = await t.setQuota({ orgId: str(i.orgId), modelId: str(i.modelId), territoryId: str(i.territoryId), period: str(i.period), amount: i.amount, ...(str(i.currency) ? { currency: str(i.currency) } : {}) });
  return { status: 'success', outputs: { success: out.success ?? true, quota: out.quota ?? null } };
}

// Parity tripwire fix (NODE-PACK-AUDIT 2026-07-17): the loader reads the
// NAMED `nodes` export (tarballLoader.ts) — without this map every declared
// node was invisible at load time (the skills-bridge bug class).
export const nodes = {
  'feature.territories.nodes.list-models': listModels,
  'feature.territories.nodes.active-model': activeModel,
  'feature.territories.nodes.list-territories': listTerritories,
  'feature.territories.nodes.list-rules': listRules,
  'feature.territories.nodes.list-quotas': listQuotas,
  'feature.territories.nodes.preview': preview,
  'feature.territories.nodes.attainment': attainment,
  'feature.territories.nodes.activate-model': activateModel,
  'feature.territories.nodes.set-quota': setQuota,
};

export default nodes;
