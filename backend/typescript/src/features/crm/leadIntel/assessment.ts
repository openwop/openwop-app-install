/**
 * ADR 0954 D4 (P4) — qualification assessments: evidence-cited answers to the
 * model's closed criteria. An assessment never sets a grade. Its answers enter
 * the deterministic score as `qualifier.<criterionId>` signals (`grading.ts`).
 *
 * Closed-world validation (`validateAssessment`) — every finding is returned, so
 * the node can feed them back for its ONE repair, after which the run fails with
 * a typed `assessment_ungrounded`; there is never a success with an empty or
 * partially valid assessment:
 *  - at least one answer; each `criterionId` is a criterion of the PINNED model
 *    version, once; an enum value is one of its values, a range value lies in it;
 *  - each answer cites at least one evidence ref, and every ref it cites was in
 *    the evidence the node READ in this run AND still resolves now (a ref the
 *    model invented, or one deleted since, is refused);
 *  - a summary of 1–400 characters (shown to people, never scored);
 *  - `bandAdjustment` ∈ {-1, 0, 1}, with a reason when it is not 0.
 *
 * A non-zero `bandAdjustment` is recorded `pending` and nothing applies it: the
 * ADR 0942 `lead.grade-adjust` gate that would is not on main yet (P4b).
 *
 * Recovery correction: history is on the erasable grade primary, written only
 * by the run the lead's grade row names as pending (the grade route stamps it),
 * and once per run (a re-execution returns the recorded row).
 */
import type { QualificationCriterion } from './model.js';
import type { EvidenceKind } from './evidence.js';
import { commitLeadAssessment, deleteLeadAssessments, readLeadAssessments, type GradeReservationPin } from './leadStore.js';

export interface AssessmentAnswer {
  criterionId: string;
  value: string | number;
  confidence: number;
  evidence: Array<{ kind: EvidenceKind; ref: string }>;
}
export interface LeadAssessment {
  tenantId: string;
  orgId: string;
  contactId: string;
  runId: string;
  modelId: string;
  modelVersion: number;
  modelHash: string;
  answers: AssessmentAnswer[];
  summary: string;
  bandAdjustment: -1 | 0 | 1;
  adjustmentReason?: string;
  /** `pending` until the ADR 0942 gate (P4b) decides; never applied in P4a. */
  adjustment: 'none' | 'pending';
  createdAt: string;
}

const MAX_SUMMARY = 400;
const MAX_REASON = 300;
const KIND_OF_PREFIX: Record<string, EvidenceKind> = { 'contact:': 'contact-field', 'activity:': 'activity', 'stated:': 'form-field' };

const kindOf = (ref: string): EvidenceKind | undefined => {
  for (const [p, k] of Object.entries(KIND_OF_PREFIX)) if (ref.startsWith(p)) return k;
  return undefined;
};

export type ValidatedAssessment = Pick<LeadAssessment, 'answers' | 'summary' | 'bandAdjustment' | 'adjustmentReason'>;

/** Closed-world validation. Returns every finding, in a form a model can act on. */
export function validateAssessment(
  criteria: readonly QualificationCriterion[], input: unknown,
  readRefs: ReadonlySet<string>, liveRefs: ReadonlySet<string>,
): { ok: true; value: ValidatedAssessment } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const byId = new Map(criteria.map((c) => [c.criterionId, c]));
  const answers: AssessmentAnswer[] = [];
  if (!Array.isArray(a.answers) || a.answers.length === 0) {
    errors.push('answers must list at least one answer.');
  } else {
    const seen = new Set<string>();
    a.answers.forEach((raw, i) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const at = `answers[${i}]`;
      const c = typeof r.criterionId === 'string' ? byId.get(r.criterionId) : undefined;
      if (!c) { errors.push(`${at}.criterionId "${String(r.criterionId)}" is not a criterion of this model (known: ${[...byId.keys()].join(', ') || 'none'}).`); return; }
      if (seen.has(c.criterionId)) { errors.push(`${at}: "${c.criterionId}" is answered twice.`); return; }
      seen.add(c.criterionId);
      let value: string | number | undefined;
      if (c.answer.kind === 'enum') {
        if (typeof r.value === 'string' && c.answer.values.includes(r.value)) value = r.value;
        else errors.push(`${at}.value for "${c.criterionId}" must be one of: ${c.answer.values.join(', ')}.`);
      } else if (typeof r.value === 'number' && Number.isFinite(r.value) && r.value >= c.answer.min && r.value <= c.answer.max) {
        value = r.value;
      } else {
        errors.push(`${at}.value for "${c.criterionId}" must be a number from ${c.answer.min} to ${c.answer.max}.`);
      }
      const confidence = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : undefined;
      if (confidence === undefined) errors.push(`${at}.confidence must be a number from 0 to 1.`);
      const ev = Array.isArray(r.evidence) ? r.evidence : [];
      const cited: AssessmentAnswer['evidence'] = [];
      if (ev.length === 0) errors.push(`${at} for "${c.criterionId}" cites no evidence; cite at least one ref from the evidence you were given.`);
      ev.forEach((e, j) => {
        const ref = typeof (e as { ref?: unknown })?.ref === 'string' ? (e as { ref: string }).ref : '';
        const kind = kindOf(ref);
        if (!kind || !readRefs.has(ref) || !liveRefs.has(ref)) errors.push(`${at}.evidence[${j}].ref "${ref}" is not in the evidence you were given.`);
        else cited.push({ kind, ref });
      });
      if (value !== undefined && confidence !== undefined && cited.length === ev.length && cited.length > 0) {
        answers.push({ criterionId: c.criterionId, value, confidence, evidence: cited });
      }
    });
  }
  const summary = typeof a.summary === 'string' ? a.summary.trim() : '';
  if (!summary || summary.length > MAX_SUMMARY) errors.push(`summary must be 1 to ${MAX_SUMMARY} characters.`);
  const adj = a.bandAdjustment ?? 0;
  if (adj !== -1 && adj !== 0 && adj !== 1) errors.push('bandAdjustment must be -1, 0 or 1.');
  const reason = typeof a.adjustmentReason === 'string' ? a.adjustmentReason.trim() : '';
  if (adj !== 0 && (!reason || reason.length > MAX_REASON)) errors.push(`A bandAdjustment other than 0 needs an adjustmentReason of up to ${MAX_REASON} characters.`);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { answers, summary, bandAdjustment: adj as -1 | 0 | 1, ...(adj !== 0 ? { adjustmentReason: reason } : {}) },
  };
}

export async function getAssessmentForRun(tenantId: string, orgId: string, contactId: string, runId: string): Promise<LeadAssessment | null> {
  return (await readLeadAssessments(tenantId, orgId, contactId)).find((a) => a.runId === runId) ?? null;
}

/** Newest accepted assessment under this exact immutable model version. */
export async function latestAssessment(tenantId: string, orgId: string, contactId: string, modelId: string, modelVersion: number): Promise<LeadAssessment | null> {
  return (await readLeadAssessments(tenantId, orgId, contactId)).filter((a) => a.modelId === modelId && a.modelVersion === modelVersion).at(-1) ?? null;
}

/** Same primary CAS owns pending authority, immutable history and closure. */
export async function recordAssessment(input: Omit<LeadAssessment, 'adjustment' | 'createdAt'>, pin: GradeReservationPin): Promise<{ outcome: 'recorded' | 'replayed' | 'superseded'; assessment: LeadAssessment | null }> {
  return commitLeadAssessment({ ...input, adjustment: input.bandAdjustment === 0 ? 'none' : 'pending', createdAt: new Date().toISOString() }, pin);
}

export async function deleteAssessmentsOf(tenantId: string, orgId: string, contactId: string): Promise<number> {
  return deleteLeadAssessments(tenantId, orgId, contactId);
}

/** The raw `qualifier.<criterionId>` value an assessment gives a model signal. */
export function qualifierRaw(a: LeadAssessment | null, criterionId: string, values?: readonly string[]): number {
  const ans = a?.answers.find((x) => x.criterionId === criterionId);
  if (!ans) return 0;
  if (typeof ans.value === 'number') return Math.max(0, ans.value);
  return values?.includes(ans.value) ? 1 : 0;
}
