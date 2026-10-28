/**
 * feature.campaign-intel.nodes — budget optimization + forecasting (ADR 0160).
 * Both compose ctx.features['campaign-intel'] (heuristic over the performance
 * store, ADR 0159). budget-optimize optionally adds a ctx.callAI scenario
 * narrative on top of the deterministic recommendation. role:"action". Pure-JS.
 */

/** ADR 0903 — no hard-coded vendor. A call passes the provider/model the node
 *  was given (a chain param frozen at instantiation, or a node input) and leaves
 *  the rest to the host: `ctx.callAI` fills a missing provider/model from the
 *  run's choice (`configurable.ai`), else the workspace's active AI binding, else
 *  the catalog default — resolved once at run start (host/runAiDefault.ts). */

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
        provider: str(i.provider) || undefined,
        model: str(i.model) || undefined,
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

/** ADR 0956 D2 — conversions credited under one attribution model (the org's
 *  default unless `model` names another), with every model beside it. Modelled
 *  web credit only: never add platform-reported conversions to it. */
export async function attributionModels(ctx) {
  const ci = ensureIntel(ctx);
  if (typeof ci.attributionModels !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel attributionModels surface unavailable (ADR 0956).' } };
  }
  const i = ctx.inputs ?? {};
  const out = await ci.attributionModels({ orgId: str(i.orgId), ...(str(i.model) ? { model: str(i.model) } : {}) });
  return { status: 'success', outputs: out };
}

/** ADR 0956 D6 — what each ad platform claims beside what the site measured,
 *  per campaign and platform, with the inflation flag and the overlap. */
export async function reconciliation(ctx) {
  const ci = ensureIntel(ctx);
  if (typeof ci.reconciliation !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel reconciliation surface unavailable (ADR 0956).' } };
  }
  const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await ci.reconciliation({ orgId: str(i.orgId), ...(str(i.model) ? { model: str(i.model) } : {}) }) };
}

/** ADR 0956 D6 — each dispatched ad, its landing page or funnel step, and the
 *  sessions and conversions credited to it. */
export async function adMap(ctx) {
  const ci = ensureIntel(ctx);
  if (typeof ci.adMap !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel adMap surface unavailable (ADR 0956).' } };
  }
  const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await ci.adMap({ orgId: str(i.orgId), ...(str(i.model) ? { model: str(i.model) } : {}) }) };
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

/** ADR 0952 D2 — the spend-cap watchdog (role side-effect: it pauses ad
 *  delivery). Reads each cap's spend through the run owner's ad connections and
 *  pauses on a breach, or when spend has been unreadable for the cap's
 *  maxStaleMinutes. A REPLAY fork serves this node's recorded outcome and pauses
 *  nothing; a BRANCH fork re-runs it against live cap state (pausing is
 *  idempotent). OFF with the `campaign-intel` toggle: an honest `disabled`. */
export async function enforceCaps(ctx) {
  const ci = ensureIntel(ctx);
  const orgId = str((ctx.inputs ?? {}).orgId);
  if (!orgId) return { status: 'failed', error: { code: 'validation_error', message: 'orgId is required.' } };
  if (typeof ci.enforceCaps !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel enforceCaps unavailable — update the feature (ADR 0952 D2).' } };
  }
  const out = await ci.enforceCaps({ orgId });
  if (out.outcome === 'disabled') return { status: 'success', outputs: { outcome: 'disabled', caps: [] } };
  if (out.outcome === 'no_acting_user') {
    return { status: 'failed', error: { code: 'no_acting_user', message: 'Spend caps are enforced as a person (their ad connections and workspace access); this run has no acting user.' } };
  }
  if (out.outcome !== 'enforced') return { status: 'failed', error: { code: 'validation_error', message: out.error || 'enforcement refused' } };
  return { status: 'success', outputs: { outcome: 'enforced', caps: out.caps } };
}

/** ADR 0956 D5 — the pre-publish UTM linter. A link that breaks the client's
 *  policy fails the step (typed); it is never auto-rewritten. */
export async function utmLint(ctx) {
  const ci = ensureIntel(ctx);
  if (typeof ci.utmLint !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel utmLint surface unavailable (ADR 0956).' } };
  }
  const i = ctx.inputs ?? {};
  const urls = Array.isArray(i.urls) ? i.urls.filter((u) => typeof u === 'string') : [];
  const out = await ci.utmLint({ orgId: str(i.orgId), urls });
  const failing = (out.results ?? []).filter((r) => Array.isArray(r.violations) && r.violations.length > 0);
  if (failing.length > 0) {
    return { status: 'failed', error: { code: 'utm_policy_violation', message: `${failing.length} link(s) break the client's UTM policy.`, results: failing, policyVersion: out.policyVersion } };
  }
  return { status: 'success', outputs: out };
}

/** ADR 0952 D3 — propose ONE reallocation plan from the upstream
 *  `budget-optimize` recommendation (or recomputed): per-campaign daily-budget
 *  ops with live "from" budgets, decreases first, cap-blocked increases dropped,
 *  and one campaign-spend approval over the whole plan. role side-effect: it
 *  opens an approval, so a REPLAY fork serves the recorded plan. */
export async function proposeReallocationNode(ctx) {
  const ci = ensureIntel(ctx);
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  if (!orgId) return { status: 'failed', error: { code: 'validation_error', message: 'orgId is required.' } };
  if (typeof ci.proposeReallocation !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel proposeReallocation unavailable — update the feature (ADR 0952 D3).' } };
  }
  const out = await ci.proposeReallocation({
    orgId, ...(str(i.campaignId) ? { campaignId: str(i.campaignId) } : {}),
    ...(i.recommendation && typeof i.recommendation === 'object' ? { recommendation: i.recommendation } : {}),
  });
  return intelOutcome(out, 'Reallocation is proposed as a person (their ad connections read the live budgets); this run has no acting user.');
}

/** ADR 0952 D3 — apply an APPROVED plan through ctx-equivalent updateBudget:
 *  decreases first; a failed decrease skips every increase; a budget changed
 *  since the proposal is `stale_budget`; an increase is re-checked against a
 *  current cap snapshot. Each op passes updateBudget's spend gate, which resolves
 *  the ADR 0942 policy itself (class ads.budget). An unapproved plan returns
 *  `awaiting_approval` (nothing applied). */
export async function applyReallocationNode(ctx) {
  const ci = ensureIntel(ctx);
  const i = ctx.inputs ?? {};
  const orgId = str(i.orgId);
  if (!orgId) return { status: 'failed', error: { code: 'validation_error', message: 'orgId is required.' } };
  if (!str(i.planId)) return { status: 'success', outputs: { outcome: 'no_plan' } };
  if (typeof ci.applyReallocation !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'campaign-intel applyReallocation unavailable — update the feature (ADR 0952 D3).' } };
  }
  const out = await ci.applyReallocation({ orgId, planId: str(i.planId) });
  if (out && out.outcome === 'requires_approval') return { status: 'success', outputs: { ...out, outcome: 'awaiting_approval' } };
  return intelOutcome(out, 'Reallocation is applied as a person (their ad connections); this run has no acting user.');
}

function intelOutcome(out, noActorMessage) {
  if (!out || out.outcome === 'disabled') return { status: 'success', outputs: { outcome: 'disabled' } };
  if (out.outcome === 'no_acting_user') return { status: 'failed', error: { code: 'no_acting_user', message: noActorMessage } };
  if (out.outcome === 'invalid' || out.outcome === 'not_found') return { status: 'failed', error: { code: 'validation_error', message: out.error || out.outcome } };
  return { status: 'success', outputs: out };
}

export const nodes = {
  'feature.campaign-intel.nodes.utm-lint': utmLint,
  'feature.campaign-intel.nodes.attribution-models': attributionModels,
  'feature.campaign-intel.nodes.reconciliation': reconciliation,
  'feature.campaign-intel.nodes.ad-map': adMap,
  'feature.campaign-intel.nodes.plan-budget': planBudgetNode,
  'feature.campaign-intel.nodes.budget-optimize': budgetOptimize,
  'feature.campaign-intel.nodes.forecast': forecast,
  'feature.campaign-intel.nodes.attribution': attribution,
  'feature.campaign-intel.nodes.pacing-check': pacingCheck,
  'feature.campaign-intel.nodes.enforce-caps': enforceCaps,
  'feature.campaign-intel.nodes.propose-reallocation': proposeReallocationNode,
  'feature.campaign-intel.nodes.apply-reallocation': applyReallocationNode,
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
        provider: str(i.provider) || undefined, model: str(i.model) || undefined,
        systemPrompt: 'You explain a computed media budget plan to a marketer in 3-5 sentences. Use ONLY the numbers provided — never invent or recompute figures.',
        messages: [{ role: 'user', content: JSON.stringify(out.plan) }],
      });
      if (ai && typeof ai.content === 'string') narrative = ai.content;
      else if (ai && ai.data) narrative = String(ai.data);
    } catch { /* narration optional */ }
  }
  return { status: 'success', outputs: { plan: out.plan, ...(narrative ? { narrative } : {}) } };
}
