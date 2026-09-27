/**
 * feature.campaign-intel.nodes — budget optimization + forecasting (ADR 0160).
 * Both compose ctx.features['campaign-intel'] (heuristic over the performance
 * store, ADR 0159). budget-optimize optionally adds a ctx.callAI scenario
 * narrative on top of the deterministic recommendation. role:"action". Pure-JS.
 */

/** DEBT-3 — pack-local mirror of the providers.json SSoT default (the
 *  anthropic `recommended: true` model; src/providers/catalog.ts
 *  getDefaultModel). ctx.callAI REQUIRES an explicit model and standalone
 *  .mjs packs cannot import the catalog, so the default lives in this ONE
 *  greppable constant — the /refresh-model-catalog sweep updates it. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function ensureIntel(ctx) {
  const ci = ctx.features && ctx.features['campaign-intel'];
  if (!ci || typeof ci.optimizeBudget !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-intel'] — the feature must be composed (ADR 0014)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-intel' },
    );
  }
  return ci;
}

function str(v) { return typeof v === 'string' ? v : ''; }

export async function budgetOptimize(ctx) {
  const ci = ensureIntel(ctx);
  const i = ctx.inputs ?? {};
  const recommendation = await ci.optimizeBudget({ orgId: str(i.orgId), ...(i.campaignId ? { campaignId: str(i.campaignId) } : {}) });

  let narrative;
  if (i.narrate && typeof ctx.callAI === 'function') {
    try {
      const ai = await ctx.callAI({
        provider: str(i.provider) || 'anthropic',
        model: str(i.model) || DEFAULT_MODEL,
        systemPrompt: 'You are a marketing budget analyst. Given a deterministic budget reallocation recommendation, explain it in 2-3 sentences a CMO can act on. Be specific about the trade-off; do not invent numbers beyond the data.',
        messages: [{ role: 'user', content: JSON.stringify(recommendation) }],
      });
      if (ai && typeof ai.content === 'string') narrative = ai.content;
    } catch { /* narrative optional */ }
  }
  return { status: 'success', outputs: { recommendation, ...(narrative ? { narrative } : {}) } };
}

export async function forecast(ctx) {
  const ci = ensureIntel(ctx);
  const i = ctx.inputs ?? {};
  const out = await ci.forecast({ orgId: str(i.orgId), ...(i.campaignId ? { campaignId: str(i.campaignId) } : {}) });
  return { status: 'success', outputs: { forecasts: out.forecasts ?? [] } };
}

export async function attribution(ctx) {
  const ci = ensureIntel(ctx);
  const i = ctx.inputs ?? {};
  const out = await ci.attribution({ orgId: str(i.orgId) });
  return { status: 'success', outputs: out };
}

export async function pacingCheck(ctx) {
  const ci = ensureIntel(ctx);
  if (typeof ci.pacingCheck !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel pacing surface unavailable (ADR 0220).' } };
  }
  const i = ctx.inputs ?? {};
  const out = await ci.pacingCheck({ orgId: str(i.orgId) });
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.campaign-intel.nodes.plan-budget': planBudgetNode,
  'feature.campaign-intel.nodes.budget-optimize': budgetOptimize,
  'feature.campaign-intel.nodes.forecast': forecast,
  'feature.campaign-intel.nodes.attribution': attribution,
  'feature.campaign-intel.nodes.pacing-check': pacingCheck,
};

export default nodes;

/** ADR 0357 P1 — the goal-based budget plan ("$X → N conversions"). The math
 *  is the surface's DETERMINISTIC planner; an optional ctx.callAI leg narrates
 *  the numbers (never computes them). */
export async function planBudgetNode(ctx) {
  const i = ctx.inputs ?? {};
  const ci = ctx.features && ctx.features['campaign-intel'];
  if (!ci || typeof ci.planBudget !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel surface unavailable' } };
  }
  const out = await ci.planBudget({
    orgId: str(i.orgId), totalBudgetMinor: Number(i.totalBudgetMinor), targetConversions: Number(i.targetConversions),
    horizonDays: Number(i.horizonDays) > 0 ? Number(i.horizonDays) : 90,
    ...(Array.isArray(i.platforms) ? { platforms: i.platforms } : {}),
  });
  let narrative;
  if (typeof ctx.callAI === 'function' && i.narrate !== false) {
    try {
      const ai = await ctx.callAI({
        provider: str(i.provider) || 'anthropic', model: str(i.model) || DEFAULT_MODEL,
        systemPrompt: 'You explain a computed media budget plan to a marketer in 3-5 sentences. Use ONLY the numbers provided — never invent or recompute figures.',
        messages: [{ role: 'user', content: JSON.stringify(out.plan) }],
      });
      if (ai && typeof ai.content === 'string') narrative = ai.content;
      else if (ai && ai.data) narrative = String(ai.data);
    } catch { /* narration optional */ }
  }
  return { status: 'success', outputs: { plan: out.plan, ...(narrative ? { narrative } : {}) } };
}
