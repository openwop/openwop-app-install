/**
 * ADR 0954 D1 — per-client lead scoring models: types, validation, the v0 model
 * and the evaluator.
 *
 * A model is evaluated by the ONE weighted-scoring engine (`host/weightedScoring.ts`)
 * under its `points` aggregation: Σ min(raw, cap) × weight over raw signal counts.
 * (`computePriority`'s other aggregations clamp to 1..10 and normalize, which cannot
 * express today's lead score; `points` is that score, inside the same engine.)
 * Bands are point floors, strictly descending; below E is F.
 */
import { createHash } from 'node:crypto';
import { computePriority, type CriteriaSet } from '../../../host/weightedScoring.js';
import { OpenwopError } from '../../../types.js';
import { isQualifierSignal, isSignalId, SIGNAL_CATALOG, type SignalId } from './signals.js';

export type Band = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const BANDS: readonly Exclude<Band, 'F'>[] = ['A', 'B', 'C', 'D', 'E'];

export interface QualificationCriterion {
  criterionId: string;
  label: string;
  answer: { kind: 'enum'; values: string[] } | { kind: 'range'; min: number; max: number };
}

/** The editable content of a model version (what its `contentHash` covers). */
export interface LeadScoringModelContent {
  /** `values` is set only on a `qualifier.<criterionId>` signal over an enum
   *  criterion: the answers that count 1 (ADR 0954 P4). */
  signals: Array<{ signalId: SignalId; weight: number; cap?: number; values?: string[] }>;
  bands: Record<Exclude<Band, 'F'>, number>;
  criteria: QualificationCriterion[];
  sla: Partial<Record<Band, { firstTouchMinutes: number }>>;
}

export interface LeadScoringModel extends LeadScoringModelContent {
  tenantId: string;
  orgId: string;
  modelId: string;
  /** Immutable per version; 0 is the built-in v0. */
  version: number;
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

/**
 * v0 — today's ADR 0297 D3 weights, exactly (a completed funnel step is worth 5
 * views, a paid order 20). Used whenever a client has no active model, so the
 * `/contacts/:id/score` read is unchanged for every tenant that never writes one.
 */
export const V0_MODEL_ID = 'v0';
export const V0_CONTENT: LeadScoringModelContent = {
  signals: [
    { signalId: 'funnel.view', weight: 1 },
    { signalId: 'funnel.completion', weight: 5 },
    { signalId: 'commerce.paid-order', weight: 20 },
  ],
  bands: { A: 100, B: 50, C: 25, D: 10, E: 1 },
  criteria: [],
  sla: {},
};

const MAX_SIGNALS = 20;
const MAX_CRITERIA = 20;
const MAX_ENUM_VALUES = 20;
const MAX_WEIGHT = 1_000;
const MAX_SLA_MINUTES = 7 * 24 * 60;
const CRITERION_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

const invalid = (field: string, message: string): OpenwopError =>
  new OpenwopError('validation_error', message, 422, { field });

const finiteNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Closed-world validation of model content (422 naming the field). */
export function validateModelContent(input: unknown): LeadScoringModelContent {
  if (!input || typeof input !== 'object') throw invalid('model', 'A scoring model must be an object.');
  const m = input as Record<string, unknown>;

  if (!Array.isArray(m.signals) || m.signals.length === 0 || m.signals.length > MAX_SIGNALS) {
    throw invalid('signals', `A model needs 1 to ${MAX_SIGNALS} signals.`);
  }
  const seen = new Set<string>();
  const signals = m.signals.map((s, i) => {
    const row = (s ?? {}) as Record<string, unknown>;
    if (!isSignalId(row.signalId)) {
      throw invalid(`signals[${i}].signalId`, `Unknown signal "${String(row.signalId)}". Known signals: ${Object.keys(SIGNAL_CATALOG).join(', ')}, or qualifier.<criterionId>.`);
    }
    if (seen.has(row.signalId)) throw invalid(`signals[${i}].signalId`, `Signal "${row.signalId}" is listed twice.`);
    seen.add(row.signalId);
    if (!finiteNonNeg(row.weight) || row.weight > MAX_WEIGHT) throw invalid(`signals[${i}].weight`, `A weight must be a number from 0 to ${MAX_WEIGHT}.`);
    if (row.cap !== undefined && !finiteNonNeg(row.cap)) throw invalid(`signals[${i}].cap`, 'A cap must be a non-negative number.');
    if (row.values !== undefined && (!Array.isArray(row.values) || !row.values.every((v) => typeof v === 'string'))) {
      throw invalid(`signals[${i}].values`, 'values must be a list of answer values.');
    }
    return {
      signalId: row.signalId, weight: row.weight,
      ...(row.cap !== undefined ? { cap: row.cap as number } : {}),
      ...(row.values !== undefined ? { values: [...new Set(row.values as string[])] } : {}),
    };
  });

  const b = (m.bands ?? {}) as Record<string, unknown>;
  const bands = {} as Record<Exclude<Band, 'F'>, number>;
  let prev = Infinity;
  for (const band of BANDS) {
    const v = b[band];
    if (!finiteNonNeg(v)) throw invalid(`bands.${band}`, `Band ${band} needs a non-negative score floor.`);
    if (v >= prev) throw invalid(`bands.${band}`, 'Band floors must be strictly descending from A to E.');
    bands[band] = v;
    prev = v;
  }

  const rawCriteria = m.criteria ?? [];
  if (!Array.isArray(rawCriteria) || rawCriteria.length > MAX_CRITERIA) throw invalid('criteria', `At most ${MAX_CRITERIA} qualification criteria.`);
  const ids = new Set<string>();
  const criteria = rawCriteria.map((c, i): QualificationCriterion => {
    const row = (c ?? {}) as Record<string, unknown>;
    if (typeof row.criterionId !== 'string' || !CRITERION_ID.test(row.criterionId)) throw invalid(`criteria[${i}].criterionId`, 'A criterion id is 1–40 lowercase letters, digits, ".", "_" or "-".');
    if (ids.has(row.criterionId)) throw invalid(`criteria[${i}].criterionId`, `Criterion "${row.criterionId}" is listed twice.`);
    ids.add(row.criterionId);
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 120) throw invalid(`criteria[${i}].label`, 'A criterion needs a label of up to 120 characters.');
    const a = (row.answer ?? {}) as Record<string, unknown>;
    if (a.kind === 'enum') {
      const values = a.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM_VALUES || !values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 80) || new Set(values).size !== values.length) {
        throw invalid(`criteria[${i}].answer.values`, `An enum answer needs 1 to ${MAX_ENUM_VALUES} distinct values.`);
      }
      return { criterionId: row.criterionId, label: row.label.trim(), answer: { kind: 'enum', values: values as string[] } };
    }
    if (a.kind === 'range') {
      if (typeof a.min !== 'number' || typeof a.max !== 'number' || !Number.isFinite(a.min) || !Number.isFinite(a.max) || a.min >= a.max) {
        throw invalid(`criteria[${i}].answer`, 'A range answer needs a finite min below its max.');
      }
      return { criterionId: row.criterionId, label: row.label.trim(), answer: { kind: 'range', min: a.min, max: a.max } };
    }
    throw invalid(`criteria[${i}].answer.kind`, 'An answer is either "enum" or "range".');
  });

  // ADR 0954 P4 — a qualifier signal must name a criterion of THIS model; an enum
  // criterion needs the answers that count (`values` ⊆ its values), a range does not.
  const byId = new Map(criteria.map((c) => [c.criterionId, c]));
  signals.forEach((sig, i) => {
    if (!isQualifierSignal(sig.signalId)) {
      if (sig.values !== undefined) throw invalid(`signals[${i}].values`, 'Only a qualifier signal takes values.');
      return;
    }
    const c = byId.get(sig.signalId.slice('qualifier.'.length));
    if (!c) throw invalid(`signals[${i}].signalId`, `"${sig.signalId}" names no criterion of this model.`);
    if (c.answer.kind === 'enum') {
      const allowed = new Set(c.answer.values);
      if (!sig.values || sig.values.length === 0 || !sig.values.every((v) => allowed.has(v))) {
        throw invalid(`signals[${i}].values`, `List the answers of "${c.criterionId}" that count (some of: ${c.answer.values.join(', ')}).`);
      }
    } else if (sig.values !== undefined) {
      throw invalid(`signals[${i}].values`, `"${c.criterionId}" is a range: its value counts, so it takes no values.`);
    }
  });

  const rawSla = (m.sla ?? {}) as Record<string, unknown>;
  if (typeof rawSla !== 'object' || Array.isArray(rawSla)) throw invalid('sla', 'sla must be an object keyed by band.');
  const sla: LeadScoringModelContent['sla'] = {};
  for (const [band, v] of Object.entries(rawSla)) {
    if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(band)) throw invalid(`sla.${band}`, 'sla keys are bands A–F.');
    const minutes = (v as { firstTouchMinutes?: unknown } | null)?.firstTouchMinutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SLA_MINUTES) {
      throw invalid(`sla.${band}.firstTouchMinutes`, `A first-touch target is 1 to ${MAX_SLA_MINUTES} whole minutes.`);
    }
    sla[band as Band] = { firstTouchMinutes: minutes };
  }
  return { signals, bands, criteria, sla };
}

/** Canonical content hash (key-order independent). */
export function contentHashOf(content: LeadScoringModelContent): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(content))).digest('hex');
}

export interface LeadScoreEvaluation {
  score: number;
  band: Band;
  parts: Partial<Record<SignalId, { raw: number; weighted: number }>>;
}

export function bandOf(score: number, bands: LeadScoringModelContent['bands']): Band {
  for (const band of BANDS) if (score >= bands[band]) return band;
  return 'F';
}

/** A catalog signal's label, or the criterion's label for a qualifier signal. */
export function signalLabel(content: Pick<LeadScoringModelContent, 'criteria'>, id: SignalId): string {
  if (!isQualifierSignal(id)) return SIGNAL_CATALOG[id].label;
  const criterionId = id.slice('qualifier.'.length);
  return content.criteria.find((c) => c.criterionId === criterionId)?.label ?? id;
}

/** Evaluate a model over raw signal counts, on the one engine. */
export function evaluateLeadScore(content: LeadScoringModelContent, raw: Partial<Record<SignalId, number>>): LeadScoreEvaluation {
  const set: CriteriaSet = {
    aggregation: 'points',
    criteria: content.signals.map((s) => ({
      id: s.signalId, name: signalLabel(content, s.signalId), weight: s.weight, direction: 'benefit' as const,
      ...(s.cap !== undefined ? { cap: s.cap } : {}),
    })),
  };
  const scores: Record<string, number> = {};
  const parts: LeadScoreEvaluation['parts'] = {};
  for (const s of content.signals) {
    const r = raw[s.signalId] ?? 0;
    scores[s.signalId] = r;
    const counted = s.cap !== undefined ? Math.min(r, s.cap) : r;
    parts[s.signalId] = { raw: r, weighted: Math.round(counted * s.weight * 100) / 100 };
  }
  const score = computePriority(set, scores);
  return { score, band: bandOf(score, content.bands), parts };
}
