/**
 * ADR 0950 P2 — the per-stage recheck and the post-promotion monitor. PURE:
 * cells, the stage's epoch and the instant in; the verdict and the snapshot out.
 *
 * Both receive units FIRST EXPOSED since the stage began, filtered on their
 * exact timestamps by observeExperiment before folding into daily cells, because those units were assigned under the stage's band
 * layout. The expected split is therefore the stage's weights, not the launch
 * weights: an SRM against launch weights would fire on every ramp.
 *
 *   recheck  G3 (SRM at the stage's weights) and G6 (guardrails) on the stage's
 *            own units (D3). A breach routes the chain to rollback.
 *   monitor  the same, plus the primary metric: a breach when the winner's
 *            always-valid confidence sequence against the holdout lies wholly
 *            below zero (D5). One look in P2; repeated looks are a follow-on.
 *
 * Not enough units yet is `underpowered`, never a pass and never a breach: the
 * caller stops the run with the experiment held at the current stage (safe and
 * monotone), and a new promotion run resumes it.
 */
import { cellsHash } from './gates.js';
import { verdictFromCells } from './observe.js';
import type { ExperimentDailyCell } from './rollup.js';
import type { AllocationEpoch, Experiment } from './types.js';

export type StageCheckOutcome = 'pass' | 'breach' | 'underpowered';

export interface StageCheck {
  outcome: StageCheckOutcome;
  breach: boolean;
  reason?: 'sample_ratio_mismatch' | 'guardrail_breach' | 'primary_regression' | 'below_stage_sample' | 'partial_coverage';
  value: Record<string, unknown>;
  snapshot: { planHash: string | null; cellsHash: string; since: string; computedAt: string; stage: number | null };
}

export function evaluateStageCheck(input: {
  experiment: Experiment;
  cells: readonly ExperimentDailyCell[];
  coverage: 'complete' | 'partial';
  /** The epoch the stage applied; its `at` bounds the cohort and its weights are the expected split. */
  epoch: AllocationEpoch;
  now: string;
  kind: 'recheck' | 'monitor';
  /** Units per arm the stage needs before it can be judged. */
  minUnitsPerArm: number;
}): StageCheck {
  const { experiment: exp, epoch, now } = input;
  const since = epoch.at.slice(0, 10);
  const subset = input.cells.filter((c) => c.day >= since);
  const live = exp.arms.filter((a) => (epoch.weights[a.key] ?? 0) > 0);
  // The verdict is computed against the stage's split, over the stage's units.
  const staged: Experiment = { ...exp, arms: live.map((a) => ({ ...a, weight: epoch.weights[a.key] ?? 0 })) };
  const v = verdictFromCells(staged, subset, input.coverage, now);
  const units = Object.fromEntries(v.arms.map((a) => [a.key, a.units]));
  const snapshot = { planHash: exp.plan?.planHash ?? null, cellsHash: cellsHash(subset), since: epoch.at, computedAt: now, stage: epoch.stage ?? null };
  const base = { units, srm: v.srm, verdict: v.verdict };
  const done = (outcome: StageCheckOutcome, reason?: StageCheck['reason'], extra: Record<string, unknown> = {}): StageCheck =>
    ({ outcome, breach: outcome === 'breach', ...(reason ? { reason } : {}), value: { ...base, ...extra }, snapshot });

  if (input.coverage !== 'complete') return done('underpowered', 'partial_coverage');

  // A breach is a breach on any data: a guardrail CS beyond its margin is always valid.
  if (v.srm?.mismatch) return done('breach', 'sample_ratio_mismatch');
  if (v.verdict.kind === 'guardrail_breach') return done('breach', 'guardrail_breach', { metric: v.verdict.metric ?? null, arm: v.verdict.arm ?? null });
  if (input.kind === 'monitor' && exp.promotion) {
    const w = v.arms.find((a) => a.key === exp.promotion!.winner);
    if (w?.confidenceSequence && w.confidenceSequence[1] < 0) return done('breach', 'primary_regression', { lift: w.delta, lower: w.confidenceSequence[0], upper: w.confidenceSequence[1] });
  }
  const smallest = Math.min(...v.arms.map((a) => a.units));
  if (smallest < input.minUnitsPerArm) return done('underpowered', 'below_stage_sample', { smallestArm: smallest, minUnitsPerArm: input.minUnitsPerArm });
  return done('pass');
}
