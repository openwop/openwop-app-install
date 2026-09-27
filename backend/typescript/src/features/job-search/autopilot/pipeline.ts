/**
 * ADR 0545 P3 — Tier-A submission, end to end.
 *
 * discover → score → eligibility → answers → grant → submit → deal, for ONE
 * listing. The campaign loop (P4) calls this per listing; keeping the single-item
 * path separate is what lets "one unanswerable question parks one application
 * and the campaign keeps going" (D3) be a property of the CALLER rather than
 * something this function has to remember.
 *
 * ## Idempotency is the phase's verification, and it has three distinct shapes
 *
 * P3 asks that a retry, a re-dispatch and a fork each produce exactly ONE
 * application. Those are three different mechanisms, not one:
 *
 *  - **Retry / re-dispatch** — the same listing offered twice, possibly
 *    concurrently. Closed by `claimSubmission`, an insert-if-absent CAS keyed
 *    `(tenant, subject, listing)`. Deliberately not a read-then-write: a
 *    `get()` followed by a `put()` is exactly the TOCTOU a retry storm
 *    produces.
 *  - **Fork / replay** — closed EARLIER and by a different rule.
 *    `consultApplyGrant` refuses `isReplay` before it reads any store, so a
 *    replayed run cannot consume budget or even observe which grants exist.
 *    The claim CAS would also stop a second row, but relying on it would let a
 *    replay burn a submit unit first, which is the part that reaches an
 *    employer.
 *
 * The ORDER below matters and is the substance of this module: claim BEFORE
 * consuming budget, consume budget BEFORE calling the board, and create the deal
 * from the same act. A claim taken after submission would let two concurrent
 * runs both submit and then argue about who records it.
 *
 * ## Refusals are outcomes, not errors
 *
 * Every early return is a named outcome with the evidence that produced it.
 * ADR 0545 D6's failure posture — "keep going, report honestly" — is only
 * achievable if the caller can tell "we chose not to apply" from "we could not",
 * and a thrown error flattens both into a stack trace.
 */
import { checkEligibility, type ApplicantConstraints } from '../domain/eligibility.js';
import { projectFitScores, JOB_FIT_CRITERIA, type FitProfile } from '../domain/fitScoring.js';
import { computePriority } from '../../../host/weightedScoring.js';
import { createApplication } from '../domain/applications.js';
import type { JobDigest } from '../domain/digest.js';
import { consultApplyGrant, claimSubmission, consumeSubmit, releaseSubmission } from '../../../host/applyGrant.js';
import { answerFor, keysFor, noteAnswerUsed, type AnswerMiss } from './answerBank.js';

/** A question an employer's form asks. */
export interface FormQuestion {
  text: string;
  required: boolean;
}

/** What the board needs, once answered. */
export interface PreparedSubmission {
  listingId: string;
  answers: Record<string, string>;
  /** Bank keys actually used, so usage counting needs no second lookup. */
  usedKeys: string[];
  /** Questions we could not answer, with why. Empty on the happy path. */
  gaps: Array<{ question: string; reason: AnswerMiss; required: boolean }>;
}

export type PipelineOutcome =
  /** Applied. `dealId` is the CRM deal (ADR 0540). */
  | { kind: 'applied'; dealId: string; matchScore: number; answersUsed: number }
  /** Already applied to this listing — the idempotent no-op. */
  | { kind: 'already-applied' }
  /** A disqualifying rule fired; the quote is the evidence. */
  | { kind: 'ineligible'; ruleId: string; reason: string; quote: string }
  /** Below the policy's floor. Not a failure — a decision. */
  | { kind: 'below-floor'; matchScore: number; floor: number }
  /** A required question nobody can answer. Park THIS ONE (D3). */
  | { kind: 'parked'; gaps: PreparedSubmission['gaps'] }
  /** The grant refused. `reason` is the ledger's own word for it. */
  | { kind: 'refused'; reason: string };

export interface PipelineInput {
  tenantId: string;
  orgId: string;
  subjectId: string;
  listingId: string;
  digest: JobDigest;
  profile: FitProfile;
  applicant: ApplicantConstraints;
  /** The questions this board's form asks. */
  questions: readonly FormQuestion[];
  /** The policy floor (D5 `minMatchScore`). */
  minMatchScore: number;
  /** Which campaign's budget this spends (ADR 0541). */
  campaignId: string;
  origin: string;
  isReplay: boolean;
  now: number;
  /** JS-LANE-1 — prefetched (subject, campaign) grant ids; consult re-reads
   *  each row fresh, so only the discovery scan is saved. Optional: a single
   *  ad-hoc application simply omits it. */
  candidateGrantIds?: readonly string[];
}

/**
 * Answer a form from the bank.
 *
 * OPTIONAL questions that miss are simply skipped — "an optional field is
 * optional" (D3 step 1), and treating one as a blocker would park applications
 * for information the employer did not ask to have.
 *
 * A `special-category` miss is ANSWERED, not skipped: declining to
 * self-identify is a real answer and the only one this system will give.
 */
export async function prepareAnswers(
  tenantId: string,
  subjectId: string,
  listingId: string,
  questions: readonly FormQuestion[],
): Promise<PreparedSubmission> {
  const answers: Record<string, string> = {};
  const usedKeys: string[] = [];
  const gaps: PreparedSubmission['gaps'] = [];

  // ONE read of the subject's keys for the whole form.
  const known = await keysFor(tenantId, subjectId);

  for (const q of questions) {
    const hit = await answerFor(tenantId, subjectId, q.text, known);
    if ('value' in hit) { answers[q.text] = hit.value; usedKeys.push(hit.questionKey); continue; }
    if (hit.miss === 'special-category') { answers[q.text] = 'Decline to self-identify'; continue; }
    if (!q.required) continue;
    gaps.push({ question: q.text, reason: hit.miss, required: true });
  }
  return { listingId, answers, usedKeys, gaps };
}

/**
 * Run one listing end to end.
 *
 * `submit` is injected rather than resolved here: the board call is the one step
 * with an outside effect, and taking it as a parameter is what lets every test
 * below drive the real ordering without a network. It is called EXACTLY once, at
 * the point both the claim and the budget have been taken.
 */
export async function applyToListing(
  input: PipelineInput,
  submit: (prepared: PreparedSubmission) => Promise<{ ok: boolean }>,
): Promise<PipelineOutcome> {
  // 1 — eligibility. A disqualifying rule is a DECISION with a quote behind it,
  //     and it costs nothing, so it runs before anything is consumed.
  const eligibility = checkEligibility(input.digest, input.applicant);
  if (!eligibility.eligible) {
    return {
      kind: 'ineligible',
      ruleId: eligibility.ruleId ?? 'unknown',
      reason: eligibility.reason ?? '',
      quote: eligibility.quote ?? '',
    };
  }

  // 2 — the floor. Also free, also a decision rather than a failure.
  const matchScore = computePriority(JOB_FIT_CRITERIA, projectFitScores(input.digest, input.profile));
  if (matchScore < input.minMatchScore) {
    return { kind: 'below-floor', matchScore, floor: input.minMatchScore };
  }

  // 3 — answers. Done BEFORE the grant is consulted so a parked application
  //     never spends a submit unit: parking is common by design (D3), and a
  //     campaign that burned budget on every parked item would exhaust its
  //     ceiling without sending anything.
  const prepared = await prepareAnswers(input.tenantId, input.subjectId, input.listingId, input.questions);
  if (prepared.gaps.length > 0) return { kind: 'parked', gaps: prepared.gaps };

  // 4 — the grant. Refuses `isReplay` before reading any store, which is what
  //     makes a fork unable to consume budget or re-submit.
  const decision = await consultApplyGrant({
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    campaignId: input.campaignId,
    commitClass: 'submit',
    tier: 'A',
    origin: input.origin,
    isReplay: input.isReplay,
    now: input.now,
    ...(input.candidateGrantIds ? { candidateGrantIds: input.candidateGrantIds } : {}),
  });
  // `refusal` is for the audit row, and the ledger's docs are explicit that a
  // caller MUST NOT branch differently on it. This one does not: every refusal
  // takes the same exit, and the reason travels only so the campaign digest can
  // say WHY it skipped (D6) rather than reporting a silent nothing.
  if (!decision.allowed || !decision.grantId) return { kind: 'refused', reason: decision.refusal ?? 'no-grant' };

  // 5 — the CLAIM, before any effect. Insert-if-absent CAS: two concurrent
  //     runs resolve to exactly one winner, and the loser learns it lost
  //     without having called the board.
  const won = await claimSubmission(input.tenantId, input.subjectId, input.listingId, decision.grantId);
  if (!won) return { kind: 'already-applied' };

  // 6 — the deal, created BEFORE the outside effect. If submission fails we
  //     have a record of an attempt; if we created it after, a crash between
  //     submit and record would leave an application sent with nothing to show
  //     for it — the one outcome an applicant cannot recover from.
  const created = await createApplication({
    tenantId: input.tenantId,
    orgId: input.orgId,
    actor: input.subjectId,
    dealId: `deal:${input.listingId}`,
    digest: input.digest,
    profile: input.profile,
    applicant: input.applicant,
  });
  if (!created.deal) {
    // The claim must not outlive a run that never sent anything: held, it
    // makes every later pass report `already-applied` for a job that was
    // never applied to (grade-trio finding 1). Grant-guarded release.
    await releaseSubmission(input.tenantId, input.subjectId, input.listingId, decision.grantId);
    return {
      kind: 'ineligible',
      ruleId: created.eligibility.ruleId ?? 'unknown',
      reason: created.eligibility.reason ?? '',
      quote: created.eligibility.quote ?? '',
    };
  }

  // 7 — the outside effect, exactly once.
  const sent = await submit(prepared);
  if (!sent.ok) {
    // Same rule: a board rejection spent nothing and sent nothing — release
    // the claim so the next pass can retry the listing.
    await releaseSubmission(input.tenantId, input.subjectId, input.listingId, decision.grantId);
    return { kind: 'refused', reason: 'board-rejected' };
  }

  // 8 — spend the unit and write the audit row the attestation reads. AFTER a
  //     successful send: the ledger records units actually spent, never units
  //     an attempt merely intended.
  await consumeSubmit(input.tenantId, decision.grantId, input.now, created.deal.dealId);
  // The keys were resolved during preparation; re-resolving them here ran the
  // whole normalisation + store lookup a SECOND time per question, on the path
  // that has already spent a submit unit.
  for (const questionKey of prepared.usedKeys) {
    await noteAnswerUsed(input.tenantId, input.subjectId, questionKey, input.now);
  }

  return {
    kind: 'applied',
    dealId: created.deal.dealId,
    matchScore: created.matchScore,
    answersUsed: Object.keys(prepared.answers).length,
  };
}
