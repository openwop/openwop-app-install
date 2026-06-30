/**
 * feature.insights-suite.nodes (ADR 0078) — pure compute nodes for the Insights &
 * Drafting Agent Suite. No host surface, no egress: deterministic math, replay-safe.
 *
 *  - variance-compute: Actual-vs-Plan for a business unit's metrics, flags off-plan.
 *  - talent-score: 9-box performance×potential → readiness category.
 */

const METRICS = ['sales', 'margin', 'labor', 'shrink'];

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Actual-vs-Plan variance for sales/margin/labor/shrink. delta = actual − plan;
 *  pct = delta/plan (null when plan is 0). A metric is FLAGGED when |pct| exceeds
 *  `thresholdPct` (default 0.05). */
export async function varianceCompute(ctx) {
  const cfg = ctx.config ?? {};
  const inputs = ctx.inputs ?? {};
  const businessUnit = String(cfg.businessUnit ?? inputs.businessUnit ?? '').trim();
  const actuals = inputs.actuals ?? cfg.actuals ?? {};
  const plan = inputs.plan ?? cfg.plan ?? {};
  const thresholdPct = num(cfg.thresholdPct) ?? 0.05;

  const variances = {};
  const flagged = [];
  for (const metric of METRICS) {
    const a = num(actuals[metric]);
    const p = num(plan[metric]);
    if (a === null || p === null) continue; // metric not provided — skip, don't fabricate
    const delta = a - p;
    const pct = p !== 0 ? delta / p : null;
    variances[metric] = { actual: a, plan: p, delta, pct };
    if (pct !== null && Math.abs(pct) >= thresholdPct) flagged.push({ metric, pct });
  }

  return {
    status: 'success',
    outputs: {
      businessUnit,
      variances,
      flagged,
      thresholdPct,
      verdict: flagged.length === 0 ? 'on_plan' : 'off_plan',
    },
  };
}

const NINE_BOX = {
  // performance(1-3) × potential(1-3) → { box (1-9), label, readiness }
  '1,1': { box: 1, label: 'Underperformer', readiness: 'not_ready' },
  '2,1': { box: 2, label: 'Effective', readiness: 'not_ready' },
  '3,1': { box: 3, label: 'Trusted Professional', readiness: 'ready_in_role' },
  '1,2': { box: 4, label: 'Inconsistent Player', readiness: 'not_ready' },
  '2,2': { box: 5, label: 'Core Player', readiness: 'developing' },
  '3,2': { box: 6, label: 'High Performer', readiness: 'ready_1_2_years' },
  '1,3': { box: 7, label: 'Rough Diamond', readiness: 'developing' },
  '2,3': { box: 8, label: 'High Potential', readiness: 'ready_1_2_years' },
  '3,3': { box: 9, label: 'Star', readiness: 'ready_now' },
};

function clamp13(v) {
  const n = Math.round(num(v) ?? 0);
  return Math.max(1, Math.min(3, n));
}

/** 9-box readiness: performance (1-3) × potential (1-3) → cell + readiness. */
export async function talentScore(ctx) {
  const inputs = ctx.inputs ?? {};
  const cfg = ctx.config ?? {};
  const subjectId = String(inputs.subjectId ?? cfg.subjectId ?? '').trim();
  if (!subjectId) return { status: 'failure', error: { code: 'subject_required', message: 'talent-score requires a subjectId.' } };
  const performance = clamp13(inputs.performance ?? cfg.performance);
  const potential = clamp13(inputs.potential ?? cfg.potential);
  const cell = NINE_BOX[`${performance},${potential}`];
  return {
    status: 'success',
    outputs: { subjectId, performance, potential, ...cell },
  };
}

export const nodes = {
  'feature.insights-suite.nodes.variance-compute': varianceCompute,
  'feature.insights-suite.nodes.talent-score': talentScore,
};

export default nodes;
