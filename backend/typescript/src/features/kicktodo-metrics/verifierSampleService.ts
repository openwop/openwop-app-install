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

import { createHash } from 'node:crypto';
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

/** KTENG-3 — the approval id for a sample, derived from its (tenant, sample)
 *  identity. Approval ids are a GLOBAL key space, so the tenant is part of it. */
function verifierSampleApprovalId(tenantId: string, sampleId: string): string {
  return `appr:kt-vsample-${createHash('sha256').update(`${tenantId}\u0000${sampleId}`).digest('hex').slice(0, 32)}`;
}

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
  const existing = await existingVerifierSample(tenantId, input.enrollmentId);
  if (existing) return existing;
  // KTENG-3 / KTX-5 — CLAIM THE SAMPLE ROW FIRST, then raise the approval only if
  // this caller won the claim. The old order (check → create approval → put row)
  // let two concurrent samplers both pass the check and both create an approval:
  // the second `put` overwrote the row, so one approval sat in the human queue
  // pointing at nothing the metric reads. The approval id is derived from the
  // sample's identity so the claimed row can name it before it exists.
  const row: VerifierSample = {
    tenantId,
    sampleId,
    enrollmentId: input.enrollmentId,
    machineSatisfied,
    approvalId: verifierSampleApprovalId(tenantId, sampleId),
    createdAt: nowIso(),
  };
  if (!(await samples.putIfAbsent(row))) {
    // Lost the claim: the winner's row is the sample; never a second approval.
    return (await existingVerifierSample(tenantId, input.enrollmentId)) ?? row;
  }
  // RESIDUAL (stated, not fixed): a crash between the claim above and this create
  // leaves a sample whose approval never existed. It is counted in `sampled` and
  // never in `resolved` (verifierQuality skips a missing approval), and a re-sample
  // returns it rather than re-raising the card. It is NOT healed here because an
  // absent approval is indistinguishable from one the approvals retention purger
  // removed after it was graded, and re-raising THAT would un-grade a sample.
  try {
    await createCommunityApproval({
      tenantId,
      kind: 'metrics-verifier-sample',
      proposal:
        `Grade the automated verifier: it judged enrollment ${input.enrollmentId} as `
        + `${machineSatisfied ? 'COMPLETE' : 'not complete'}. Approve if you agree; reject if you disagree.`,
      refId: sampleId,
      submittedBy: input.submittedBy,
      approvalId: row.approvalId,
    });
  } catch (err) {
    // A THROWN create (unlike a crash) can release the claim, so a retry is not
    // wedged on a sample with no card — but only if the approval really is absent.
    if (!(await getApproval(row.approvalId))) await samples.delete(`${tenantId}::${sampleId}`);
    throw err;
  }
  log.info('kicktodo_verifier_sampled', { enrollmentId: input.enrollmentId });
  return row;
}

/** The sample already minted for this enrollment (current or legacy id shape), if
 *  any. The monthly daemon reads this so a re-visited enrollment never counts as a
 *  NEW sample (code-grade KTX-1). */
export async function existingVerifierSample(tenantId: string, enrollmentId: string): Promise<VerifierSample | null> {
  return (await samples.get(`${tenantId}::${enrollmentId}`))
    ?? (await samples.get(`${tenantId}::${enrollmentId}::sat`))
    ?? (await samples.get(`${tenantId}::${enrollmentId}::unsat`))
    ?? null;
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
