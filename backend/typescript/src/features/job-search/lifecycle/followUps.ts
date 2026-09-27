/**
 * ADR 0546 D1/P2 — follow-ups as bounded work items.
 *
 * ## The cap is the feature
 *
 * "Never more than one follow-up per application per stage, ever." The failure
 * mode here is not a missed nudge — it is becoming the candidate who emails four
 * times, which costs the user the role. So the count is enforced **at the
 * store**, by an insert-if-absent CAS on a deterministic key, not by a prompt
 * and not by a read-then-write. P2's verification is that the cap holds under
 * retry, re-dispatch AND fork, and those are different failures: a retry races
 * itself, a fork replays a decision that was already made.
 *
 * The key is `(tenant, deal, stage)` and contains nothing time-varying, so a
 * second attempt collides by construction. There is deliberately no "force"
 * argument: an escape hatch on this rule would be used, and the rule is the
 * product.
 *
 * ## Cadence is per stage, not global
 *
 * A nudge after *applied* should be rare and late; a thank-you after an
 * *interview* should be same-day. One global `followupDays` — the baseline's
 * model — gets both wrong, and gets the important one wrong in the direction
 * that costs an offer.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../../host/dataClassification.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../../host/retentionPurger.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';

/** Stages a follow-up can attach to, with their cadence in hours. */
export const FOLLOW_UP_CADENCE: Readonly<Record<string, number>> = {
  // Late and rare: an employer who has not screened in a week is not waiting on
  // a nudge, and the second nudge is what gets a candidate remembered badly.
  applied: 7 * 24,
  // A screening call deserves a prompter, still-polite check-in.
  screening: 3 * 24,
  // Same-day. This is the thank-you, and it is the one that actually moves a
  // decision — which is why a single global cadence is not good enough.
  interviewing: 4,
  // An outstanding offer is time-critical for both sides.
  offer: 12,
};

export interface FollowUp {
  tenantId: string;
  dealId: string;
  /** The stage that warranted it. Part of the key: one per stage, ever. */
  stage: string;
  subjectId: string;
  dueAt: string;
  createdAt: string;
  /** Set when the card was completed. A done follow-up is never re-created. */
  completedAt?: string;
}

/**
 * The SUBJECT is part of the key, so one person's queue is a bounded prefix
 * read rather than a tenant scan filtered afterwards — the answer bank's rule,
 * applied here after the grading pass flagged the tenant-wide list (`JS-LIFE-1`).
 * In a shared workspace the old shape read every member's rows to answer one
 * member's question.
 */
const key = (tenantId: string, subjectId: string, dealId: string, stage: string): string =>
  `${tenantId}:${subjectId}:${dealId}:${stage}`;

export const followUps = new DurableCollection<FollowUp>(
  'job-search:followup',
  (f) => key(f.tenantId, f.subjectId, f.dealId, f.stage),
  undefined,
  (f) => f.tenantId,
);

declarePiiFields('job-search.followup', ['dealId']);

export async function eraseSubjectFollowUps(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await followUps.listByPrefix(`${tenantId}:`)) {
    if (!forms.has(row.subjectId)) continue;
    await followUps.delete(key(row.tenantId, row.subjectId, row.dealId, row.stage));
  }
}
registerSubjectEraser(eraseSubjectFollowUps);

/** Why a follow-up was not created. Never a silent no-op. */
export type FollowUpRefusal =
  /** One already exists for this deal at this stage. The cap. */
  | 'already-exists'
  /** This stage has no cadence — it does not warrant a follow-up. */
  | 'stage-not-followed'
  /** A replayed run must not re-create work that already happened. */
  | 'replay';

/**
 * Schedule the ONE follow-up for a deal at a stage.
 *
 * Refuses a replay outright rather than relying on the CAS. Both would leave one
 * row, but a fork that reached the CAS would have already done the work of
 * deciding — and ADR 0531's rule is that a replayed run does not re-decide, it
 * reads what was decided.
 */
export async function scheduleFollowUp(input: {
  tenantId: string;
  dealId: string;
  subjectId: string;
  stage: string;
  now: number;
  isReplay: boolean;
}): Promise<FollowUp | { refused: FollowUpRefusal }> {
  if (input.isReplay) return { refused: 'replay' };

  const stage = input.stage.trim().toLowerCase();
  const hours = FOLLOW_UP_CADENCE[stage];
  if (hours === undefined) return { refused: 'stage-not-followed' };

  const row: FollowUp = {
    tenantId: input.tenantId,
    dealId: input.dealId,
    stage,
    subjectId: input.subjectId,
    dueAt: new Date(input.now + hours * 3_600_000).toISOString(),
    createdAt: new Date(input.now).toISOString(),
  };

  // Insert-if-absent. NOT a get-then-put: two concurrent stage transitions on
  // the same deal is exactly the race that produces the four-email candidate.
  const won = await followUps.compareAndSwap(null, row);
  return won ? row : { refused: 'already-exists' };
}

/** Follow-ups that are due and not yet done. */
export async function dueFollowUps(tenantId: string, subjectId: string, now: number): Promise<FollowUp[]> {
  const nowIso = new Date(now).toISOString();
  return (await followUps.listByPrefix(`${tenantId}:${subjectId}:`))
    .filter((f) => !f.completedAt && f.dueAt <= nowIso)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
}

/**
 * Mark one done.
 *
 * Completion does NOT delete the row, and that is the cap: a deleted row would
 * let the same stage schedule a second follow-up, which is the exact behaviour
 * the hard rule forbids.
 */
export async function completeFollowUp(tenantId: string, subjectId: string, dealId: string, stage: string, now: number): Promise<boolean> {
  const row = await followUps.get(key(tenantId, subjectId, dealId, stage.trim().toLowerCase()));
  if (!row || row.completedAt) return false;
  await followUps.put({ ...row, completedAt: new Date(now).toISOString() });
  return true;
}

// Retention. A follow-up completed two years ago and a draft for a job long
// since filled are both personal data kept for no reason (JS-DATA-2). Ages out
// by `createdAt` — the answer bank already had this and these did not.
registerRetentionPurger({
  feature: 'job-search:followup',
  // The seam calls purge(tenantId, CLASSIFICATION, cutoffIso). The previous
  // binding named the second slot `cutoffIso`, so every sweep compared
  // timestamps against the classification STRING — and every ISO date sorts
  // before 'confidential-pii'/'internal'/'public', so ONE sweep of ANY
  // classification would have deleted this store's every row for the tenant.
  // Gate on the store's own classification (declared PII) + the true cutoff.
  purge: async (tenantId, classification, cutoffIso) =>
    classification !== 'confidential-pii' ? 0 : purgeRowsByAge(
      'job-search:followup',
      await followUps.listForTenantIndexed(tenantId),
      tenantId,
      cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.createdAt, id: key(r.tenantId, r.subjectId, r.dealId, r.stage) }),
      (id) => followUps.delete(id),
    ),
});
