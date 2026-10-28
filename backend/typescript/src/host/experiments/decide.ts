/**
 * ADR 0949 D2 — Decide mode, the pure half: plan validation and locking, the plan
 * hash, and the verdict. No I/O, no clock (the caller passes `now`), so the same
 * inputs always give the same verdict.
 *
 * Verdict (a closed enum, D2): `insufficient_data | running | srm_halt |
 * winner(arm) | no_difference | guardrail_breach(metric) | inconclusive_at_max`.
 * Before `minDays` AND `minSamplePerArm` are both met, no inference is reported:
 * the confidence sequences are shown, never a call.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { benjaminiHochberg, defaultMixingVariance, msprtProportions, sampleRatioMismatch, sampleSizePerArm, SRM_ALPHA } from './stats.js';
import type { Arm, Experiment, PlanInput, PreRegistration } from './types.js';

/** The primary metric is a conversion. Guardrails name a metric the surface's
 *  adapter reports (`supportedMetrics`); the service refuses any other at lock
 *  (`unsupported_metric`), so a guardrail is never accepted and then ignored. */
export const SUPPORTED_PRIMARY_METRICS = ['conversion'] as const;
export const MIN_DAYS_FLOOR = 7;
export const MAX_DAYS_CAP = 180;

const bad = (field: string, message: string): never => {
  throw new OpenwopError('validation_error', message, 400, { field });
};

const num = (v: unknown, field: string, lo: number, hi: number, inclusive = false): number => {
  const x = typeof v === 'number' ? v : Number.NaN;
  const ok = inclusive ? x >= lo && x <= hi : x > lo && x < hi;
  if (!Number.isFinite(x) || !ok) bad(field, `${field} must be a number ${inclusive ? 'from' : 'between'} ${lo} ${inclusive ? 'to' : 'and'} ${hi}.`);
  return x;
};

const PLAN_KEYS = new Set(['primaryMetric', 'guardrails', 'baselineRate', 'mde', 'alpha', 'power', 'fdrQ', 'minDays', 'maxDays']);

/** Closed-world plan validation: unknown keys and out-of-range values are typed
 *  400s, never dropped. Returns the normalised input. */
export function parsePlanInput(raw: unknown): PlanInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('plan', 'plan must be an object.');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!PLAN_KEYS.has(k)) bad(k, `Unknown plan field \`${k}\`.`);
  const pm = o.primaryMetric as { kind?: unknown; name?: unknown } | undefined;
  if (!pm || typeof pm !== 'object' || typeof pm.name !== 'string' || !pm.name.trim()) bad('primaryMetric', 'primaryMetric needs a kind and a name.');
  if (!(SUPPORTED_PRIMARY_METRICS as readonly unknown[]).includes(pm!.kind)) bad('primaryMetric', 'The primary metric must be a conversion (the only metric the surfaces count today).');
  const guardrailsRaw = o.guardrails ?? [];
  if (!Array.isArray(guardrailsRaw)) bad('guardrails', 'guardrails must be an array.');
  if ((guardrailsRaw as unknown[]).length > 5) bad('guardrails', 'A plan can name at most 5 guardrails.');
  const guardrails = (guardrailsRaw as unknown[]).map((g) => {
    const r = (g ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!['metric', 'direction', 'niMargin'].includes(k)) bad('guardrails', `Unknown guardrail field \`${k}\`.`);
    const m = r.metric as { kind?: unknown; name?: unknown } | undefined;
    if (!m || typeof m.name !== 'string' || !m.name.trim() || m.name.trim() === 'conversion') bad('guardrails', 'A guardrail names a metric other than the primary.');
    if (r.direction !== 'up_is_bad' && r.direction !== 'down_is_bad') bad('guardrails', 'A guardrail direction is up_is_bad or down_is_bad.');
    const niMargin = num(r.niMargin, 'guardrails.niMargin', 0, 1);
    return { metric: { kind: 'rate', name: String(m!.name).trim() }, direction: r.direction as 'up_is_bad' | 'down_is_bad', niMargin };
  });
  if (new Set(guardrails.map((g) => g.metric.name)).size !== guardrails.length) bad('guardrails', 'Each guardrail metric appears once.');
  const baselineRate = num(o.baselineRate, 'baselineRate', 0, 1);
  const mde = num(o.mde, 'mde', 0, 1);
  if (baselineRate + mde >= 1) bad('mde', 'baselineRate + mde must stay below 1.');
  const alpha = num(o.alpha, 'alpha', 0, 0.2);
  const power = num(o.power, 'power', 0.5, 1);
  const fdrQ = num(o.fdrQ, 'fdrQ', 0, 0.2);
  const minDays = Math.max(MIN_DAYS_FLOOR, Math.ceil(num(o.minDays ?? MIN_DAYS_FLOOR, 'minDays', 1, MAX_DAYS_CAP, true)));
  const maxDays = Math.ceil(num(o.maxDays, 'maxDays', 1, MAX_DAYS_CAP, true));
  if (maxDays < minDays) bad('maxDays', `maxDays must be at least minDays (${minDays}).`);
  return { primaryMetric: { kind: 'conversion', name: String(pm!.name).trim() }, guardrails, baselineRate, mde, alpha, power, fdrQ, minDays, maxDays };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** sha256 over the canonicalised plan AND the arms it was powered for. */
export function planHash(plan: Omit<PreRegistration, 'lockedAt' | 'planHash'>, arms: readonly Arm[]): string {
  return createHash('sha256').update(canonical({ plan, arms: arms.map((a) => ({ key: a.key, ref: a.ref, weight: a.weight })) })).digest('hex');
}

/** The power calculator for a request or a run: a typed 400 for inputs that do
 *  not describe two rates in (0, 1) at a sensible alpha and power. */
export function powerCalc(raw: { baselineRate: unknown; mde: unknown; alpha: unknown; power: unknown }): number {
  const baselineRate = num(raw.baselineRate, 'baselineRate', 0, 1);
  const mde = num(raw.mde, 'mde', 0, 1);
  if (baselineRate + mde >= 1) bad('mde', 'baselineRate + mde must stay below 1.');
  return sampleSizePerArm(baselineRate, mde, { alpha: num(raw.alpha, 'alpha', 0, 0.2), power: num(raw.power, 'power', 0.5, 1) });
}

/** Lock: derive the per-arm sample size and hash the plan. */
export function lockPlan(input: PlanInput, arms: readonly Arm[], now: string): PreRegistration {
  // Each treatment arm is compared with the control: power each comparison at
  // the plan's alpha (BH controls the false discovery rate across them).
  const minSamplePerArm = sampleSizePerArm(input.baselineRate, input.mde, { alpha: input.alpha, power: input.power });
  const body = { ...input, minSamplePerArm };
  return { ...body, lockedAt: now, planHash: planHash(body, arms) };
}

export type VerdictKind = 'insufficient_data' | 'running' | 'srm_halt' | 'winner' | 'no_difference' | 'guardrail_breach' | 'inconclusive_at_max';

export interface Verdict {
  kind: VerdictKind;
  /** `winner`: the arm. */
  arm?: string;
  /** `guardrail_breach`: the metric. */
  metric?: string;
  /** `insufficient_data`: why. */
  reason?: 'no_plan' | 'not_launched' | 'abandoned' | 'no_units' | 'coverage' | 'min_days' | 'min_sample';
}

export interface ArmTotals {
  key: string; units: number; conversions: number;
  /** ADR 0949 P3 — units with each guardrail outcome. */
  guardrails?: Record<string, number>;
}

export interface ArmInference {
  key: string;
  units: number;
  conversions: number;
  rate: number;
  /** Treatment arms only: the lift over the control, its always-valid (1 − α)
   *  confidence sequence, the per-look mSPRT p-value and the BH q-value. */
  delta?: number;
  confidenceSequence?: [number, number];
  pValue?: number;
  qValue?: number;
}

export interface DecideResult {
  verdict: Verdict;
  arms: ArmInference[];
  srm: { chiSquare: number; pValue: number; mismatch: boolean; alpha: number } | null;
  gates: { minDays: number; daysElapsed: number; minSamplePerArm: number; smallestArm: number; met: boolean };
}

const DAY_MS = 86_400_000;

/**
 * The Decide verdict. `totals` are in the experiment's arm order (index 0 is the
 * control). `now` is an ISO instant.
 */
export function decideVerdict(exp: Pick<Experiment, 'arms' | 'plan' | 'status' | 'startedAt' | 'stoppedAt'>, totals: readonly ArmTotals[], coverage: 'complete' | 'partial', now: string): DecideResult {
  const plan = exp.plan;
  const arms: ArmInference[] = totals.map((t) => ({ key: t.key, units: t.units, conversions: t.conversions, rate: t.units > 0 ? t.conversions / t.units : 0 }));
  const end = exp.status === 'running' ? now : (exp.stoppedAt ?? now);
  const daysElapsed = exp.startedAt ? Math.max(0, Math.floor((Date.parse(end) - Date.parse(exp.startedAt)) / DAY_MS)) : 0;
  const smallestArm = Math.min(...totals.map((t) => t.units));
  const gates = { minDays: plan?.minDays ?? MIN_DAYS_FLOOR, daysElapsed, minSamplePerArm: plan?.minSamplePerArm ?? 0, smallestArm, met: false };
  const srmRaw = sampleRatioMismatch(totals.map((t) => t.units), exp.arms.map((a) => a.weight), SRM_ALPHA);
  const srm = srmRaw ? { chiSquare: srmRaw.chiSquare, pValue: srmRaw.pValue, mismatch: srmRaw.mismatch, alpha: SRM_ALPHA } : null;
  const done = (verdict: Verdict): DecideResult => ({ verdict, arms, srm, gates });

  if (!plan) return done({ kind: 'insufficient_data', reason: 'no_plan' });
  // An abandoned test's numbers stay readable, but it never makes a call (D2).
  if (exp.status === 'abandoned') return done({ kind: 'insufficient_data', reason: 'abandoned' });
  if (!exp.startedAt) return done({ kind: 'insufficient_data', reason: 'not_launched' });
  if (coverage === 'partial') return done({ kind: 'insufficient_data', reason: 'coverage' });
  if (srm?.mismatch) return done({ kind: 'srm_halt' });
  if (totals.every((t) => t.units === 0)) return done({ kind: 'insufficient_data', reason: 'no_units' });

  // Guardrails (ADR 0949 D2): a one-sided non-inferiority test per treatment arm
  // and guardrail. A breach is called when the always-valid confidence sequence
  // for (treatment − control) lies entirely beyond the margin in the bad
  // direction; always valid, so it is checked at every look, before the gates.
  for (const g of plan.guardrails) {
    const c = totals[0]!;
    for (const t of totals.slice(1)) {
      const r = msprtProportions(c.guardrails?.[g.metric.name] ?? 0, c.units, t.guardrails?.[g.metric.name] ?? 0, t.units, { tau2: defaultMixingVariance(g.niMargin), alpha: plan.alpha });
      if (!r) continue;
      const breached = g.direction === 'up_is_bad' ? r.confidenceSequence[0] > g.niMargin : r.confidenceSequence[1] < -g.niMargin;
      if (breached) return done({ kind: 'guardrail_breach', metric: g.metric.name, arm: t.key });
    }
  }

  // The confidence sequences are always computed (always valid, D2); the CALL waits for the gates.
  const control = totals[0]!;
  const tau2 = defaultMixingVariance(plan.mde);
  const tests = totals.slice(1).map((t) => msprtProportions(control.conversions, control.units, t.conversions, t.units, { tau2, alpha: plan.alpha }));
  const pValues = tests.map((r) => r?.pValue ?? 1);
  const bh = benjaminiHochberg(pValues, plan.fdrQ);
  tests.forEach((r, i) => {
    const a = arms[i + 1]!;
    if (r) { a.delta = r.delta; a.confidenceSequence = r.confidenceSequence; a.pValue = r.pValue; }
    a.qValue = bh.adjusted[i];
  });

  gates.met = daysElapsed >= plan.minDays && smallestArm >= plan.minSamplePerArm;
  const fallback = (): DecideResult => exp.status === 'running'
    ? done({ kind: 'running' })
    : done({ kind: 'insufficient_data', reason: daysElapsed < plan.minDays ? 'min_days' : 'min_sample' });
  if (!gates.met) {
    if (daysElapsed >= plan.maxDays) return done({ kind: 'inconclusive_at_max' });
    return fallback();
  }

  const rejected = tests.map((r, i) => (r && bh.rejected[i] ? { key: totals[i + 1]!.key, delta: r.delta } : null)).filter((x): x is { key: string; delta: number } => x !== null);
  const better = rejected.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta);
  if (better.length > 0) return done({ kind: 'winner', arm: better[0]!.key });
  if (rejected.length > 0 && rejected.length === tests.length) return done({ kind: 'winner', arm: control.key });
  // Every treatment arm's confidence sequence sits inside ±mde: the effect, if
  // any, is smaller than the one the test was powered to find.
  const within = tests.every((r) => r !== null && r.confidenceSequence[0] > -plan.mde && r.confidenceSequence[1] < plan.mde);
  if (within) return done({ kind: 'no_difference' });
  if (daysElapsed >= plan.maxDays) return done({ kind: 'inconclusive_at_max' });
  return fallback();
}
