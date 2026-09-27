/**
 * ADR 0545 P4 — the campaign loop, exception batching and the digest.
 *
 * ## The ordering that is the whole point
 *
 * D3: "Prior art parks first and asks immediately, which is why one novel
 * question stops the loop. Here the campaign continues and the human is
 * interrupted in batches, on their schedule." So this loop NEVER awaits a human.
 * A parked item is recorded and the next listing is attempted — the interruption
 * is deferred to a card the user opens when they choose.
 *
 * That makes "keep going" a property of the loop rather than of each caller, and
 * it is the difference between a product that is on autopilot and one that is
 * data entry with extra steps.
 *
 * ## Every outcome is reported, including the boring ones
 *
 * D6: "a silent skip is indistinguishable from a job that was never found, and
 * that is the failure mode that erodes trust in an autonomous product." The
 * digest therefore counts EVERY outcome, and `skipped` carries its reason. A
 * digest that reported only successes would be a marketing artefact.
 *
 * A deliberate consequence: an ineligible listing and a below-floor listing are
 * counted separately, because "we were not allowed to apply" and "we chose not
 * to" are different facts about someone's job search.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../../host/dataClassification.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { applyToListing, type PipelineInput, type PipelineOutcome, type PreparedSubmission } from './pipeline.js';
import { applyGrants } from '../../../host/applyGrant.js';
import { createLogger } from '../../../observability/logger.js';
import type { AnswerMiss } from './answerBank.js';

const log = createLogger('job-search.campaign');

/**
 * One question a campaign could not answer, waiting for a batched confirmation.
 *
 * Keyed by (tenant, subject, questionKey) rather than by application: the SAME
 * unanswered question blocking six applications is ONE thing to ask, and
 * recording it per-application is how "3 questions, ~40 seconds" turns back into
 * eighteen interruptions.
 */
export interface ParkedQuestion {
  tenantId: string;
  subjectId: string;
  questionKey: string;
  questionText: string;
  reason: AnswerMiss;
  /** Applications currently waiting on this one answer. */
  blockedListings: string[];
  firstSeenAt: string;
  updatedAt: string;
}

const parkedKey = (tenantId: string, subjectId: string, questionKey: string): string =>
  `${tenantId}:${subjectId}:${questionKey}`;

export const parkedQuestions = new DurableCollection<ParkedQuestion>(
  'job-search:parked-question',
  (p) => parkedKey(p.tenantId, p.subjectId, p.questionKey),
  undefined,
  (p) => p.tenantId,
);

// The question TEXT can carry an employer's phrasing about the applicant; the
// blocked listings are a record of what they applied to.
declarePiiFields('job-search.parked-question', ['questionText', 'blockedListings']);

/** ADR 0464 — the subject's own backlog. Delete, like the answers themselves. */
export async function eraseSubjectParked(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await parkedQuestions.listByPrefix(`${tenantId}:`)) {
    if (!forms.has(row.subjectId)) continue;
    await parkedQuestions.delete(parkedKey(row.tenantId, row.subjectId, row.questionKey));
  }
}
registerSubjectEraser(eraseSubjectParked);

/** Record (or extend) a parked question. Idempotent per question. */
export async function park(
  tenantId: string,
  subjectId: string,
  gap: { question: string; reason: AnswerMiss },
  listingId: string,
  now: number,
): Promise<void> {
  // The key is the question TEXT normalised the same way the bank normalises it,
  // so two employers' phrasings of one question do not become two chores.
  const { resolveQuestionKey } = await import('./questionKey.js');
  const { key } = resolveQuestionKey(gap.question);
  const existing = await parkedQuestions.get(parkedKey(tenantId, subjectId, key));
  const blocked = new Set(existing?.blockedListings ?? []);
  blocked.add(listingId);
  await parkedQuestions.put({
    tenantId,
    subjectId,
    questionKey: key,
    questionText: existing?.questionText ?? gap.question,
    reason: gap.reason,
    blockedListings: [...blocked],
    firstSeenAt: existing?.firstSeenAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
}

/** The batched exceptions card (D3): what to ask, once, for everything. */
export async function listParked(tenantId: string, subjectId: string): Promise<ParkedQuestion[]> {
  return parkedQuestions.listByPrefix(`${tenantId}:${subjectId}:`);
}

/** Clear a parked question once it has been answered. */
export async function clearParked(tenantId: string, subjectId: string, questionKey: string): Promise<void> {
  await parkedQuestions.delete(parkedKey(tenantId, subjectId, questionKey));
}

/**
 * What happened in a campaign run. Every listing lands in exactly one bucket.
 *
 * `skipped` is a LIST, not a count: D6's requirement is that a skip is reported
 * with its reason, and a number cannot say why.
 */
export interface CampaignDigest {
  considered: number;
  applied: string[];
  alreadyApplied: number;
  parked: Array<{ listingId: string; questions: string[] }>;
  skipped: Array<{ listingId: string; reason: string; detail: string }>;
}

export interface CampaignItem {
  listingId: string;
  input: Omit<PipelineInput, 'listingId'>;
}

/**
 * Run a campaign over many listings.
 *
 * Sequential on purpose: the grant ledger has a rate limit and a ceiling, and
 * firing every listing concurrently would spend the budget in an order nobody
 * chose. It also keeps `already-applied` meaningful — a concurrent burst would
 * race itself into that branch.
 *
 * A THROWN error from one listing does not stop the run. That is the same rule
 * as parking, applied to the failure nobody predicted: an adapter that breaks on
 * one employer must not end a campaign, and D6 requires it be reported rather
 * than swallowed.
 */
export async function runCampaign(
  items: readonly CampaignItem[],
  submit: (prepared: PreparedSubmission) => Promise<{ ok: boolean }>,
  now: number,
): Promise<CampaignDigest> {
  const digest: CampaignDigest = { considered: 0, applied: [], alreadyApplied: 0, parked: [], skipped: [] };

  // JS-LANE-1 — ONE discovery scan per (tenant, subject, campaign) TRIPLE
  // instead of one per submittable item. Memoized PER TRIPLE, not hoisted off
  // `items[0]` (the grade-trio caught that shape: a mixed-subject batch made
  // every later subject's items refuse `no-grant` against the first subject's
  // id list — false, and reported as the user's fault). Only the IDS are
  // reused; `consultApplyGrant` re-reads each row fresh at decision time, so
  // a mid-run revocation or a pace window filling up is seen exactly as
  // before. A triple with zero discovered grants passes `undefined` so the
  // consult keeps its own full-scan semantics ([] would silently mean
  // "no candidates, don't look").
  const grantIdsByTriple = new Map<string, string[]>();
  const candidateIdsFor = async (inp: { tenantId: string; subjectId: string; campaignId: string }): Promise<string[]> => {
    const key = `${inp.tenantId}:${inp.subjectId}:${inp.campaignId}`;
    let ids = grantIdsByTriple.get(key);
    if (!ids) {
      ids = (await applyGrants.listByPrefix(`${inp.tenantId}:`))
        .filter((g) => g.subjectId === inp.subjectId && g.campaignId === inp.campaignId)
        .map((g) => g.grantId);
      grantIdsByTriple.set(key, ids);
    }
    return ids;
  };

  for (const item of items) {
    digest.considered += 1;
    const ids = await candidateIdsFor(item.input);
    const input: PipelineInput = {
      ...item.input,
      listingId: item.listingId,
      ...(ids.length > 0 ? { candidateGrantIds: ids } : {}),
    };
    let outcome: PipelineOutcome;
    try {
      outcome = await applyToListing(input, submit);
    } catch (err) {
      // Reported, never silent — an unexplained gap in the digest is the exact
      // thing D6 says erodes trust.
      digest.skipped.push({
        listingId: item.listingId,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    switch (outcome.kind) {
      case 'applied':
        digest.applied.push(outcome.dealId);
        break;
      case 'already-applied':
        digest.alreadyApplied += 1;
        break;
      case 'parked': {
        for (const gap of outcome.gaps) {
          await park(input.tenantId, input.subjectId, gap, item.listingId, now);
        }
        digest.parked.push({ listingId: item.listingId, questions: outcome.gaps.map((g) => g.question) });
        break;
      }
      case 'ineligible':
        digest.skipped.push({ listingId: item.listingId, reason: 'ineligible', detail: outcome.quote || outcome.reason });
        break;
      case 'below-floor':
        digest.skipped.push({
          listingId: item.listingId,
          reason: 'below-floor',
          detail: `scored ${outcome.matchScore}, floor ${outcome.floor}`,
        });
        break;
      case 'refused':
        digest.skipped.push({ listingId: item.listingId, reason: 'refused', detail: outcome.reason });
        break;
    }
  }

  // D6 is about the USER seeing what happened, and the digest carries that. But
  // an operator debugging "why did nothing go out last night" has only the
  // response, which nobody kept. One structured line makes the same honesty
  // available after the fact (`JS-AUTO-2` from the grading pass).
  log.info('job_search_campaign_run', {
    considered: digest.considered,
    applied: digest.applied.length,
    alreadyApplied: digest.alreadyApplied,
    parked: digest.parked.length,
    skipped: digest.skipped.length,
    // Reasons only — never the listing ids or question text, which are the
    // applicant's business and would put their job search in the logs.
    skipReasons: [...new Set(digest.skipped.map((s) => s.reason))],
  });
  return digest;
}

/**
 * Does the digest account for every listing it was given?
 *
 * Exported because it is the invariant D6 actually asks for, and an invariant
 * that only exists inside a test is one the next change can quietly break.
 */
export function digestIsComplete(digest: CampaignDigest): boolean {
  const accounted =
    digest.applied.length + digest.alreadyApplied + digest.parked.length + digest.skipped.length;
  return accounted === digest.considered;
}
