/**
 * ADR 0432 P3 — verifier false-positive/false-negative rate from SAMPLED human
 * review (PRD §15). The automated judge's trustworthiness is the one metric
 * that cannot be derived from the judge itself, so it samples and asks a human.
 *
 * The review queue is the EXISTING approvals owner (a `metrics-verifier-sample`
 * kind — the ADR 0426 precedent); this module owns only the sample records and
 * the rate derivation. The rate is computed from RESOLVED samples only and
 * always reports its denominator: an unstated denominator is a lie.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { createCommunityApproval, getApproval } from '../../host/approvalService.js';
import { getEnrollment } from '../kicktodo-core/enrollmentService.js';
import { getGoal } from '../goals/goalsService.js';

const log = createLogger('kicktodo.verifierSample');

export interface VerifierSample {
  tenantId: string;
  /** Deterministic: one sample per ENROLLMENT — resampling converges (ARCH-M2).
   *  Rows written before that change encode the verdict too
   *  (`<enrollmentId>::sat|unsat`); `sampleVerdict` reads those legacy ids so
   *  they are reused rather than duplicated (KTD-12). Never parse this — the
   *  enrollment is carried in its own field. */
  sampleId: string;
  enrollmentId: string;
  /** What the automated judge decided. */
  machineSatisfied: boolean;
  approvalId: string;
  createdAt: string;
}

const samples = new DurableCollection<VerifierSample>(
  'kicktodo-verifier-samples',
  (s) => `${s.tenantId}::${s.sampleId}`,
);

const nowIso = (): string => new Date().toISOString();

/** Mint ONE sample for human grading. Idempotent by the deterministic id. */
export class SampleSubjectError extends Error {
  constructor() {
    super('That enrollment cannot be sampled.');
  }
}

/**
 * KTFULL-B18 — sample a REAL verdict.
 *
 * The caller previously supplied both the enrollment id AND the machine
 * verdict, so anyone could mint samples for enrollments that do not exist,
 * asserting whatever verdict made the FP/FN rate look good — the metric was
 * manipulable by the party it measures. Now the enrollment must exist in the
 * caller's tenant and the verdict is READ FROM THE JUDGE (the goal's recorded
 * `lastVerdict`), never accepted from the request. An enrollment the judge has
 * not yet ruled on is not sampleable — there is no verdict to grade.
 */
export async function sampleVerdict(
  tenantId: string,
  input: { enrollmentId: string; submittedBy: string },
): Promise<VerifierSample> {
  const enrollment = await getEnrollment(tenantId, input.enrollmentId);
  if (!enrollment) throw new SampleSubjectError();
  const goal = enrollment.goalId ? await getGoal(tenantId, enrollment.goalId) : null;
  const verdict = goal?.completion?.lastVerdict;
  if (!verdict || typeof verdict.satisfied !== 'boolean') throw new SampleSubjectError();
  const machineSatisfied = verdict.satisfied;
  // ARCH-M2 — ONE sample per enrollment. The id used to encode the verdict, so
  // a judge that flipped its ruling minted a SECOND row: `verifierQuality` then
  // counted one enrollment twice — plausibly as a false positive AND a false
  // negative for the same event — while the first approval sat in the human
  // queue describing a verdict that no longer existed. The sample records the
  // verdict as a FIELD; the identity is the enrollment.
  const sampleId = input.enrollmentId;
  // KTD-12 — the id SHAPE changed (it used to encode the verdict). A row written
  // under the old shape still matches `verifierQuality`'s `${tenantId}::` prefix
  // scan, so it is not orphaned from reads — but the idempotency probe below
  // would MISS it and mint a second row for the same enrollment, reintroducing
  // the exact ARCH-M2 double-count this change removed. Read the legacy ids
  // before minting so the one-sample-per-enrollment invariant survives the
  // shape change without a backfill.
  const existing = (await samples.get(`${tenantId}::${sampleId}`))
    ?? (await samples.get(`${tenantId}::${input.enrollmentId}::sat`))
    ?? (await samples.get(`${tenantId}::${input.enrollmentId}::unsat`));
  if (existing) return existing;
  const approval = await createCommunityApproval({
    tenantId,
    kind: 'metrics-verifier-sample',
    proposal:
      `Grade the automated verifier: it judged enrollment ${input.enrollmentId} as `
      + `${machineSatisfied ? 'COMPLETE' : 'not complete'}. Approve if you agree; reject if you disagree.`,
    refId: sampleId,
    submittedBy: input.submittedBy,
  });
  const row: VerifierSample = {
    tenantId,
    sampleId,
    enrollmentId: input.enrollmentId,
    machineSatisfied,
    approvalId: approval.approvalId,
    createdAt: nowIso(),
  };
  await samples.put(row);
  log.info('kicktodo_verifier_sampled', { enrollmentId: input.enrollmentId });
  return row;
}

export interface VerifierQuality {
  /** Total samples minted. */
  sampled: number;
  /** Samples a human has actually graded — THE denominator for every rate. */
  resolved: number;
  agreed: number;
  /** Machine said complete, human disagreed. */
  falsePositives: number;
  /** Machine said not-complete, human disagreed. */
  falseNegatives: number;
  /** Null until at least one sample is graded — never a rate over zero. */
  disagreementRate: number | null;
}

/** Derive quality from RESOLVED samples only, denominator always reported. */
export async function verifierQuality(tenantId: string): Promise<VerifierQuality> {
  const rows = await samples.listByPrefix(`${tenantId}::`);
  let resolved = 0;
  let agreed = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const row of rows) {
    const approval = await getApproval(row.approvalId);
    if (!approval || approval.status === 'pending') continue; // ungraded ⇒ not counted
    resolved += 1;
    const humanAgrees = approval.status === 'approved';
    if (humanAgrees) agreed += 1;
    else if (row.machineSatisfied) falsePositives += 1;
    else falseNegatives += 1;
  }
  return {
    sampled: rows.length,
    resolved,
    agreed,
    falsePositives,
    falseNegatives,
    disagreementRate: resolved === 0 ? null : Math.round(((resolved - agreed) / resolved) * 1000) / 1000,
  };
}

// ADR 0458 P0 — NO registerSubjectEraser and NO registerRetentionPurger (deliberate, with
// reason). A VerifierSample measures the AUTOMATED JUDGE, not a person: it records that some
// enrollment was machine-judged complete/not and whether a human grader agreed. It is keyed
// by enrollment (`sampleId === enrollmentId`), carries NO subject key and no personal free
// text — after kicktodo-core deletes the enrollment on a DSAR, the sample's `enrollmentId`
// is an opaque, dereferenceable token. Erasing samples on a DSAR would silently corrupt the
// FP/FN DENOMINATOR of a quality metric (an unstated/shrunk denominator is the exact lie
// this module was built to avoid). So it is operational (`internal`) QA data on neither
// seam, and holds no aged PII for the time-based sweep.

/** Test-only: the module-private collection, for erasure/seed assertions. */
export const __test = { samples };
