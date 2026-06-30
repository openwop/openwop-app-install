/**
 * feature.campaign-intel.nodes — budget optimization + forecasting (ADR 0160).
 * Both compose ctx.features['campaign-intel'] (heuristic over the performance
 * store, ADR 0159). budget-optimize optionally adds a ctx.callAI scenario
 * narrative on top of the deterministic recommendation. role:"action". Pure-JS.
 */

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
        model: str(i.model) || 'claude-sonnet-4-6',
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

export const nodes = {
  'feature.campaign-intel.nodes.budget-optimize': budgetOptimize,
  'feature.campaign-intel.nodes.forecast': forecast,
};

export default nodes;
