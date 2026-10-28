/**
 * ADR 0950 D2 — the promotion gates. PURE: counts, the verdict and the instant
 * in; every gate's status, value and rule out, plus the snapshot hash a replay
 * re-checks. No clock (`now` is an input), no I/O. A gate that cannot be computed
 * is `not_evaluable`, never a pass: only an all-`pass` checklist promotes.
 *
 * "Recent" (G3) and "trailing" (G7) are COHORT-based: a cell is keyed by the
 * day its units were first exposed, so the last 7 days means units first seen in
 * the last 7 days. Recent cohorts have had less time to convert, which biases
 * both arms alike; the gates compare signs and ratios, not absolute rates.
 */
import { createHash } from 'node:crypto';
import { MIN_SESSIONS_PER_VARIANT } from '../variantAssignment.js';
import { MIN_DAYS_FLOOR, type DecideResult } from './decide.js';
import { sampleRatioMismatch, SRM_ALPHA } from './stats.js';
import type { ExperimentDailyCell } from './rollup.js';
import type { Experiment } from './types.js';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8';
export type GateStatus = 'pass' | 'fail' | 'not_evaluable';

export interface GateResult {
  id: GateId;
  status: GateStatus;
  /** A short machine reason (`legacy_experiment`, `below_sample`, …). */
  reason?: string;
  /** The numbers the gate read, recorded so a replay shows them. */
  value: Record<string, unknown>;
}

export interface ContentCheck { ok: boolean; reason?: string }

export interface GateReport {
  experimentId: string;
  /** The arm a promotion would ship, when the verdict names one (never the control). */
  winner: string | null;
  gates: GateResult[];
  allPass: boolean;
  snapshot: { planHash: string | null; cellsHash: string; computedAt: string };
}

const DAY_MS = 86_400_000;

function totals(cells: readonly ExperimentDailyCell[], metric = 'conversion'): Map<string, { n: number; sum: number }> {
  const out = new Map<string, { n: number; sum: number }>();
  for (const c of cells) {
    if ((c.metric ?? 'conversion') !== metric) continue;
    const t = out.get(c.arm) ?? { n: 0, sum: 0 };
    t.n += c.n; t.sum += c.sum; out.set(c.arm, t);
  }
  return out;
}

const rate = (t: { n: number; sum: number } | undefined): number | null => (t && t.n > 0 ? t.sum / t.n : null);

/** sha256 over the canonical cells (sorted by id; only the counted fields). */
export function cellsHash(cells: readonly ExperimentDailyCell[]): string {
  const canon = [...cells].sort((a, b) => a.cellId.localeCompare(b.cellId)).map((c) => [c.cellId, c.metric ?? 'conversion', c.n, c.sum, c.sumSq]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** Lift (winner rate − control rate) over a subset of cells; null when either side is empty. */
function liftOver(cells: readonly ExperimentDailyCell[], control: string, winner: string): number | null {
  const t = totals(cells);
  const c = rate(t.get(control));
  const w = rate(t.get(winner));
  return c === null || w === null ? null : w - c;
}

export function evaluateGates(input: {
  experiment: Experiment;
  cells: readonly ExperimentDailyCell[];
  verdict: DecideResult;
  now: string;
  /** G8 — the surface's own promotability check of the winner's content; null
   *  when there is no winner to check or the surface has no check. */
  content: ContentCheck | null;
}): GateReport {
  const { experiment: exp, cells, verdict, now } = input;
  const plan = exp.plan;
  const control = exp.arms[0]!.key;
  const winner = verdict.verdict.kind === 'winner' && verdict.verdict.arm && verdict.verdict.arm !== control ? verdict.verdict.arm : null;
  const gates: GateResult[] = [];

  // G1 — mode
  gates.push(exp.legacy === true
    ? { id: 'G1', status: 'fail', reason: 'legacy_experiment', value: { mode: exp.mode, legacy: true } }
    : exp.mode !== 'decide'
      ? { id: 'G1', status: 'fail', reason: 'not_decide', value: { mode: exp.mode } }
      : !plan
        ? { id: 'G1', status: 'fail', reason: 'plan_not_locked', value: { mode: exp.mode } }
        // D2: a stopped (or abandoned) Decide test reports its state but is never promoted.
        : exp.status !== 'running'
          ? { id: 'G1', status: 'fail', reason: 'not_running', value: { mode: exp.mode, status: exp.status } }
          : { id: 'G1', status: 'pass', value: { mode: exp.mode, planHash: plan.planHash } });

  // G2 — duration and sample (a plan-less experiment is held to the floors, labelled)
  const minDays = Math.max(MIN_DAYS_FLOOR, plan?.minDays ?? MIN_DAYS_FLOOR);
  const minSample = plan?.minSamplePerArm ?? MIN_SESSIONS_PER_VARIANT;
  const end = exp.status === 'running' ? now : (exp.stoppedAt ?? now);
  const days = exp.startedAt ? Math.max(0, Math.floor((Date.parse(end) - Date.parse(exp.startedAt)) / DAY_MS)) : 0;
  const all = totals(cells);
  const smallest = Math.min(...exp.arms.map((a) => all.get(a.key)?.n ?? 0));
  gates.push({
    id: 'G2', status: days >= minDays && smallest >= minSample ? 'pass' : 'fail',
    // Name every failing leg: a new test with three sessions is both.
    ...(days < minDays && smallest < minSample ? { reason: 'too_short_and_below_sample' } : days < minDays ? { reason: 'too_short' } : smallest < minSample ? { reason: 'below_sample' } : {}),
    value: { days, minDays, smallestArm: smallest, minSamplePerArm: minSample, floors: plan ? 'plan' : 'default_floors' },
  });

  // G3 — SRM over the whole test and over units first seen in the last 7 days
  const weights = exp.arms.map((a) => a.weight);
  const recentCutoff = new Date(Date.parse(now) - 7 * DAY_MS).toISOString().slice(0, 10);
  const recent = cells.filter((c) => c.day >= recentCutoff);
  const recentTotals = totals(recent);
  const srmAll = sampleRatioMismatch(exp.arms.map((a) => all.get(a.key)?.n ?? 0), weights, SRM_ALPHA);
  const srmRecent = sampleRatioMismatch(exp.arms.map((a) => recentTotals.get(a.key)?.n ?? 0), weights, SRM_ALPHA);
  gates.push(!srmAll
    ? { id: 'G3', status: 'not_evaluable', reason: 'no_units', value: {} }
    : { id: 'G3', status: srmAll.mismatch || srmRecent?.mismatch ? 'fail' : 'pass', ...(srmAll.mismatch || srmRecent?.mismatch ? { reason: 'sample_ratio_mismatch' } : {}),
        value: { pValue: srmAll.pValue, recentPValue: srmRecent?.pValue ?? null, alpha: SRM_ALPHA } });

  // G4 — the primary verdict names a treatment arm
  gates.push(winner
    ? { id: 'G4', status: 'pass', value: { verdict: verdict.verdict } }
    : { id: 'G4', status: 'fail', reason: verdict.verdict.kind === 'winner' ? 'control_wins' : verdict.verdict.kind, value: { verdict: verdict.verdict } });

  // G5 — practical significance: point lift ≥ MDE and the CS lower bound > 0
  const inf = winner ? verdict.arms.find((a) => a.key === winner) : undefined;
  if (!winner || !inf || inf.delta === undefined || !inf.confidenceSequence || !plan) {
    gates.push({ id: 'G5', status: 'not_evaluable', reason: 'no_winner', value: {} });
  } else {
    const ok = inf.delta >= plan.mde && inf.confidenceSequence[0] > 0;
    gates.push({ id: 'G5', status: ok ? 'pass' : 'fail', ...(ok ? {} : { reason: inf.delta < plan.mde ? 'below_mde' : 'interval_includes_zero' }),
      value: { lift: inf.delta, mde: plan.mde, lower: inf.confidenceSequence[0], upper: inf.confidenceSequence[1] } });
  }

  // G6 — guardrails
  gates.push(verdict.verdict.kind === 'guardrail_breach'
    ? { id: 'G6', status: 'fail', reason: 'guardrail_breach', value: { metric: verdict.verdict.metric ?? null, arm: verdict.verdict.arm ?? null } }
    : { id: 'G6', status: 'pass', value: { guardrails: (plan?.guardrails ?? []).map((g) => g.metric.name) } });

  // G7 — novelty stability: trailing-7-day lift ≥ 50% of the full lift, same
  // sign, and no monotone decline across three or more weekly slices.
  if (!winner) {
    gates.push({ id: 'G7', status: 'not_evaluable', reason: 'no_winner', value: {} });
  } else {
    const full = liftOver(cells, control, winner);
    const trailing = liftOver(recent, control, winner);
    const weekly: number[] = [];
    if (exp.startedAt) {
      const start = Date.parse(exp.startedAt.slice(0, 10));
      const weeks = Math.floor((Date.parse(end) - start) / (7 * DAY_MS));
      for (let w = 0; w < weeks; w++) {
        const from = new Date(start + w * 7 * DAY_MS).toISOString().slice(0, 10);
        const to = new Date(start + (w + 1) * 7 * DAY_MS).toISOString().slice(0, 10);
        const l = liftOver(cells.filter((c) => c.day >= from && c.day < to), control, winner);
        if (l !== null) weekly.push(l);
      }
    }
    const decaying = weekly.length >= 3 && weekly.every((l, i) => i === 0 || l < weekly[i - 1]!);
    if (full === null || trailing === null) {
      gates.push({ id: 'G7', status: 'not_evaluable', reason: 'no_recent_units', value: { fullLift: full, trailingLift: trailing } });
    } else {
      const stable = full > 0 && trailing > 0 && trailing >= 0.5 * full && !decaying;
      gates.push({ id: 'G7', status: stable ? 'pass' : 'fail', ...(stable ? {} : { reason: decaying ? 'monotone_decline' : 'novelty_fade' }),
        value: { fullLift: full, trailingLift: trailing, weeklyLifts: weekly } });
    }
  }

  // G8 — the winner's content may be published now (the surface decides)
  gates.push(!winner
    ? { id: 'G8', status: 'not_evaluable', reason: 'no_winner', value: {} }
    : !input.content
      ? { id: 'G8', status: 'not_evaluable', reason: 'no_content_check', value: {} }
      : { id: 'G8', status: input.content.ok ? 'pass' : 'fail', ...(input.content.ok ? {} : { reason: input.content.reason ?? 'content_blocked' }), value: { arm: winner } });

  return {
    experimentId: exp.experimentId, winner, gates, allPass: gates.every((g) => g.status === 'pass'),
    snapshot: { planHash: plan?.planHash ?? null, cellsHash: cellsHash(cells), computedAt: now },
  };
}
