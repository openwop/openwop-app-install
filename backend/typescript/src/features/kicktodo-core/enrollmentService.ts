/**
 * Enrollment saga + occurrence materialization (ADR 0414 P1; PRD §8.3–§8.4).
 *
 * Multi-owner creation (enrollment, board, goal, occurrences/cards) is a saga
 * with DETERMINISTIC keys at every step, so a re-fired enrollment converges on
 * the same rows instead of duplicating them:
 *   - enrollment id  ← (tenant, ownerSubject, challengeId, version)
 *   - board id       ← (tenant, ownerSubject)         [ONE board per user]
 *   - goal           ← ADR 0412 owner, one per enrollment (principal-owned)
 *   - card id        ← (enrollmentId, localDate, stableActivityId, planRevision)
 *
 * PLAN-REVISION SUPERSESSION (PRD §6.3, second-pass review finding): ids are
 * idempotent only WITHIN a revision — `applyPlanRevision` atomically supersedes
 * the prior revision's NON-TERMINAL occurrences/cards (terminal cards keep
 * their history/evidence) before the new revision materializes.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createBoard, createCard, deleteCard, getBoard, getCard, updateCardFields } from '../../host/kanbanService.js';
import { armContinuation, createGoal, transitionGoal } from '../goals/goalsService.js';
import { registerJob, setJobEnabled } from '../../host/schedulingService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { isNotificationMuted } from '../../host/notificationPolicy.js';
import { emitKicktodoLifecycle } from './lifecycleEvents.js';
import { createLogger } from '../../observability/logger.js';
import { getChallenge } from './challengeService.js';
import { fireEnrollmentDeleted } from './enrollmentLifecycle.js';
import { ensureKickBot, KICKBOT_AGENT_ID } from './kickbotService.js';
import {
  dueDaysOn,
  effectiveDateForDay,
  mapDayToDate,
  enrollmentId as deriveEnrollmentId,
  localDateIn,
  occurrenceCardId,
  participantBoardId,
  recoveryActivityId,
  EVIDENCE_RANK,
  type ChallengeActivity,
  type ChallengeDefinition,
  type ChallengeEnrollment,
  type EvidencePolicy,
  type KickTodoActionOccurrence,
} from './types.js';

const log = createLogger('kicktodo.enrollment');

/** KTFULL-B5 — the daily materialization slot. Early morning in the
 *  ENROLLMENT's own timezone, so "today's actions" exist before the
 *  participant's day starts rather than appearing mid-afternoon. */
const DAILY_LOOP_CRON = '0 5 * * *';

/** Keyed `${tenant}::${enrollmentId}`. */
const enrollments = new DurableCollection<ChallengeEnrollment>(
  'kicktodo-enrollments',
  (e) => `${e.tenantId}::${e.id}`,
);

/** Keyed `${tenant}::${enrollmentId}::${localDate}::${stableActivityId}::r${rev}`
 *  — Today's read is a bounded per-enrollment/day prefix scan; the row also
 *  point-resolves by its deterministic `cardId` via a second index-free get
 *  (cardId embeds the same tuple). */
const occurrences = new DurableCollection<KickTodoActionOccurrence>(
  'kicktodo-occurrences',
  (o) => `${o.tenantId}::${o.enrollmentId}::${o.occurrenceDateLocal}::${o.stableActivityId}::r${o.planRevision}`,
);

const nowIso = (): string => new Date().toISOString();

/** The verifier ref every enrollment goal declares; the ADR 0414 P3 progress
 *  evaluator registers under it (goals fail closed until then — by design). */
export const KICKTODO_GOAL_VERIFIER_REF = 'kicktodo:progress-evidence';

/** ADR 0420 P1 — the enroll-guard inversion: an adapter (kicktodo-commerce)
 *  registers a predicate; core never imports commerce. Guards run BEFORE any
 *  saga step; a deny is a typed refusal, never a partial enrollment. */
export type EnrollGuard = (args: {
  tenantId: string;
  ownerSubject: string;
  challenge: ChallengeDefinition;
}) => Promise<{ ok: true } | { ok: false; reason: string }>;
const enrollGuards: EnrollGuard[] = [];
export function registerEnrollGuard(fn: EnrollGuard): void { enrollGuards.push(fn); }
export function __clearEnrollGuards(): void { enrollGuards.length = 0; }

export class EnrollDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export class SubstitutionDeniedError extends Error {
  constructor(public readonly reason: 'occurrence-not-found' | 'superseded' | 'not-owner' | 'unknown-alternative' | 'evidence-policy-mismatch') {
    super('That substitution is not available.'); // uniform message — no existence leak
  }
}

export class ChallengeNotEnrollableError extends Error {
  constructor(public readonly reason: 'not-found' | 'not-published') {
    super(reason === 'not-found' ? 'Challenge not found.' : 'Challenge version is not open for enrollment.');
  }
}

export interface EnrollInput {
  tenantId: string;
  ownerSubject: string;
  challengeId: string;
  challengeVersion: number;
  timezone?: string;
  /** ADR 0443 R2 — ENROLL-TIME-ONLY allowed weekdays (0=Sun..6=Sat). Frozen with
   *  `startDateLocal` so the day↔date mapping is deterministic forever; a
   *  mid-flight change is the KickBot re-plan lane (OQ1). */
  daysOfWeek?: number[];
  /** ADR 0444 I1 — a raw invite token, resolved server-side to stamp
   *  attribution. Invalid/revoked tokens are IGNORED (attribution must never
   *  break enrolling), and the token grants nothing else. */
  inviteToken?: string;
}

export class InvalidDaysOfWeekError extends Error {
  constructor() { super('daysOfWeek must be a non-empty set of integers 0–6.'); }
}

/** ADR 0444 I1 — resolve the invite token to an attribution stamp. Self-invites
 *  don't count (no self-referral); anything invalid resolves to no stamp. */
async function inviteAttribution(
  tenantId: string,
  rawToken: string | undefined,
  ownerSubject: string,
): Promise<{ invitedBy?: string }> {
  if (!rawToken) return {};
  const { resolveInvite } = await import('./inviteService.js');
  const row = await resolveInvite(tenantId, rawToken);
  if (!row || row.inviterSubject === ownerSubject) return {};
  return { invitedBy: row.inviterSubject };
}

/** Normalize + validate the R2 preference: ints 0–6, deduped, sorted; an empty
 *  array is refused (it would mean "never"); undefined = every day. */
function normalizeDaysOfWeek(days: number[] | undefined): number[] | undefined {
  if (days === undefined) return undefined;
  const clean = [...new Set(days)].sort((a, b) => a - b);
  if (clean.length === 0 || clean.length > 7 || clean.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new InvalidDaysOfWeekError();
  }
  return clean;
}

/** The participant's ONE KickTodo board — created WITHOUT trigger columns
 *  (PRD §6.3: placing a human action in "To Do" must never start a workflow). */
async function ensureParticipantBoard(tenantId: string, ownerSubject: string): Promise<string> {
  const id = participantBoardId(tenantId, ownerSubject);
  const existing = await getBoard(id);
  if (existing) return id;
  await createBoard({
    id,
    tenantId,
    name: 'My KickTodo actions',
    ownerSubject: { kind: 'user', id: ownerSubject },
    columns: [
      { id: 'todo', name: 'To Do' },
      { id: 'done', name: 'Done', terminal: true, terminalKind: 'completion' },
    ],
  });
  return id;
}

/**
 * The enrollment saga (PRD §8.3). Idempotent end-to-end: re-invocation
 * converges (same enrollment/board/cards; the goal is created once because the
 * enrollment row records its id — forward repair re-creates only what is
 * missing).
 */
export async function enroll(input: EnrollInput): Promise<{ enrollment: ChallengeEnrollment; challenge: ChallengeDefinition }> {
  const challenge = await getChallenge(input.tenantId, input.challengeId, input.challengeVersion);
  if (!challenge) throw new ChallengeNotEnrollableError('not-found');
  if (challenge.status !== 'published' || !challenge.contentHash) throw new ChallengeNotEnrollableError('not-published');

  const id = deriveEnrollmentId(input.tenantId, input.ownerSubject, input.challengeId, input.challengeVersion);
  const prior = await enrollments.get(`${input.tenantId}::${id}`);
  if (prior) {
    // Idempotent re-enroll: converge (repair any missing occurrences for today).
    await materializeOccurrences(input.tenantId, prior.id);
    return { enrollment: prior, challenge };
  }

  // ADR 0420 P1 — registered guards (entitlements, capacity) gate NEW
  // enrollments only: an existing enrollment above converges regardless (a
  // revoked entitlement refuses re-purchase paths, never strands active work).
  for (const guard of enrollGuards) {
    const verdict = await guard({ tenantId: input.tenantId, ownerSubject: input.ownerSubject, challenge });
    if (!verdict.ok) throw new EnrollDeniedError(verdict.reason);
  }

  const timezone = input.timezone ?? 'UTC';
  const boardId = await ensureParticipantBoard(input.tenantId, input.ownerSubject);
  // ADR 0414 P2 — the guide exists before the first plan conversation (lazy,
  // idempotent; provisioned heartbeat-off/review — never autonomous).
  const kickbot = await ensureKickBot(input.tenantId);

  // One bounded goal per enrollment (ADR 0412 owner; principal-owned by the
  // participant; redaction-safe objective — the title is published content).
  const goal = await createGoal({
    objective: `Complete challenge: ${challenge.title}`,
    completion: { check: 'verifier', verifierRef: KICKTODO_GOAL_VERIFIER_REF },
    continuation: { mode: 'schedule' },
    bounds: {
      maxLoopIterations: challenge.durationDays + 7,
      runTimeoutMs: challenge.durationDays * 2 * 86_400_000,
    },
    owner: { tenant: input.tenantId, principal: input.ownerSubject },
  });

  const enrollment: ChallengeEnrollment = {
    id,
    tenantId: input.tenantId,
    ownerSubject: input.ownerSubject,
    challengeId: challenge.id,
    challengeVersion: challenge.version,
    challengeContentHash: challenge.contentHash,
    state: 'active',
    goalId: goal.id,
    boardId,
    planRevision: 1,
    timezone,
    startDateLocal: localDateIn(timezone),
    // ADR 0443 R2 — frozen at enroll (validated); absent = every day.
    ...(normalizeDaysOfWeek(input.daysOfWeek)
      ? { schedulePreference: { daysOfWeek: normalizeDaysOfWeek(input.daysOfWeek)! } }
      : {}),
    // ADR 0444 I1 — attribution only; a bad token is silently no attribution.
    ...(await inviteAttribution(input.tenantId, input.inviteToken, input.ownerSubject)),
    createdAt: nowIso(),
  };
  // Create-CAS: two concurrent first-enrolls race on the deterministic id —
  // the loser must not leave a second goal behind (code-review finding C1-R1).
  const won = await enrollments.compareAndSwap(null, enrollment);
  if (!won) {
    await transitionGoal(input.tenantId, goal.id, 'abandon', input.ownerSubject); // orphan cleanup
    const winner = await enrollments.get(`${input.tenantId}::${id}`);
    if (winner) {
      await materializeOccurrences(input.tenantId, id);
      return { enrollment: winner, challenge };
    }
  }
  await materializeOccurrences(input.tenantId, id);

  // KTFULL-B5 — ARM the daily continuation. The goal is created with
  // `continuation: { mode: 'schedule' }`, which DECLARES an intent to run
  // daily, but nothing armed it: `armContinuation` had no production caller,
  // so no deterministic materialization/coach cadence was ever established and
  // the "daily loop" existed only as a workflow definition nobody fired.
  //
  // Fired in the ENROLLMENT's timezone (the PRD's timezone-truth rule) and
  // best-effort: a scheduler hiccup must not fail an enrolment the participant
  // already completed. `armContinuation` is idempotent — the job id is
  // derived from (tenant, goalId) — so a retry converges rather than
  // registering a second job.
  try {
    await armContinuation(
      input.tenantId,
      goal.id,
      {
        workflowId: 'openwop-app.kicktodo.daily-loop',
        cronExpr: DAILY_LOOP_CRON,
        timezone,
        // The daily loop's `materialize`/`evaluate` nodes read
        // `input('enrollmentId')` and `input('ownerSubject')`. Seed them, or
        // every scheduled fire runs against an undefined enrollment.
        inputs: { enrollmentId: id, ownerSubject: input.ownerSubject },
        // ADR 0442 P2 — attribute the Daily Coach schedule to KickBot: the fired
        // loop shows under KickBot's Schedules + Activity tabs. Presentation
        // ONLY — it does NOT create a second cadence (heartbeat stays off) and
        // must NEVER mirror the daily occurrences onto KickBot's board: the
        // participant action board is the single completion truth (D3;
        // kickbotService.ts "never a second completion truth").
        rosterId: kickbot.rosterId,
        agentId: KICKBOT_AGENT_ID,
      },
      input.ownerSubject,
    );
  } catch (err) {
    log.warn('kicktodo_continuation_arm_failed', {
      enrollmentId: id,
      goalId: goal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('kicktodo_enrolled', { enrollmentId: id, challengeId: challenge.id, version: challenge.version });

  // ADR 0444 I2 — tell the inviter someone joined through their link (the ONE
  // notification seam; best-effort — a notify hiccup never fails an enrollment).
  // Content-minimal: the challenge title only, never the joiner's identity
  // (the invitee decides their own disclosures via circles, ADR 0419).
  // ADR 0457 — respect the inviter's app-level notification mute / quiet-hours
  // before the courtesy notify (the emitter does not auto-consult it; fail-open
  // so an unconfigured resolver still delivers).
  if (enrollment.invitedBy && !(await isNotificationMuted(input.tenantId, enrollment.invitedBy, { type: 'task.assigned', priority: 'normal' }))) {
    try {
      await getNotificationEmitter().emit({
        tenantId: input.tenantId,
        recipientUserId: enrollment.invitedBy,
        type: 'task.assigned',
        priority: 'normal',
        title: 'Your invite was accepted',
        message: `Someone joined “${challenge.title}” through your invite link.`,
        actionUrl: `/kicktodo/discover/${encodeURIComponent(challenge.id)}`,
        metadata: { category: 'kicktodo-invite-accepted' },
      });
    } catch (err) {
      log.warn('kicktodo_invite_notify_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // ADR 0456 P2 — consent-gated lifecycle signal for CDP marketing. No-ops
  // unless the subject has a linked Contact (Gate 0); best-effort internally.
  await emitKicktodoLifecycle(input.tenantId, enrollment.ownerSubject, 'enrolled', { challengeId: challenge.id, challengeVersion: challenge.version });
  return { enrollment, challenge };
}

export async function getEnrollment(tenantId: string, id: string): Promise<ChallengeEnrollment | null> {
  const e = await enrollments.get(`${tenantId}::${id}`);
  return e && e.tenantId === tenantId ? e : null;
}

/** ADR 0443 R1 — reminder cron per daypart, fired in the ENROLLMENT's timezone.
 *  Materialization is untouched (KTFULL-B5's 05:00 slot stays the plan truth);
 *  this cadence only *reminds*. */
const REMINDER_CRONS: Record<'morning' | 'afternoon' | 'evening', string> = {
  morning: '0 8 * * *',
  afternoon: '0 13 * * *',
  evening: '0 18 * * *',
};

/** Deterministic reminder-job id — tenant-scoped (the ADR 0379 cross-tenant
 *  overwrite guard keys on this), distinct from the goal continuation id so the
 *  daily loop is never overwritten (the armContinuation id-collision finding). */
export function reminderJobId(tenantId: string, enrollmentId: string): string {
  return `kicktodo:${tenantId}:${enrollmentId}:reminder`;
}

/**
 * ADR 0443 R1 — set (or clear) the participant's opt-in reminder daypart.
 * Owner-only, CAS point-write on the enrollment row. Setting a daypart upserts
 * ONE scheduler job (the single cadence engine — a second JOB, never a second
 * engine) running the reminder-loop workflow at the daypart hour in the
 * enrollment's timezone, KickBot-attributed (ADR 0442 P2). Clearing DISABLES the
 * job (kept-armed-but-disabled mirrors the sibling daily-loop's no-disarm
 * posture; the remind node also skips non-active enrollments, so snooze pauses
 * reminders — deck slide 14 — with no extra choreography).
 */
export async function setSchedulePreference(
  tenantId: string,
  enrollmentId: string,
  ownerSubject: string,
  daypart: 'morning' | 'afternoon' | 'evening' | null,
): Promise<ChallengeEnrollment | null> {
  let updated: ChallengeEnrollment | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const e = await getEnrollment(tenantId, enrollmentId);
    if (!e || e.ownerSubject !== ownerSubject) return null;
    // R2 correction to R1: MERGE the preference — daypart changes must never drop
    // the enroll-time-frozen daysOfWeek (and clearing the daypart keeps it too).
    const keepDays = e.schedulePreference?.daysOfWeek;
    const next: ChallengeEnrollment = {
      ...e,
      ...(daypart || keepDays
        ? { schedulePreference: { ...(daypart ? { daypart } : {}), ...(keepDays ? { daysOfWeek: keepDays } : {}) } }
        : {}),
    };
    if (!daypart && !keepDays) delete next.schedulePreference;
    if (await enrollments.compareAndSwap(e, next)) { updated = next; break; }
  }
  if (!updated) return await getEnrollment(tenantId, enrollmentId);

  const jobId = reminderJobId(tenantId, enrollmentId);
  if (daypart) {
    const kickbot = await ensureKickBot(tenantId);
    const res = await registerJob({
      jobId,
      tenantId,
      cronExpr: REMINDER_CRONS[daypart],
      workflowId: 'openwop-app.kicktodo.reminder-loop',
      enabled: true,
      timezone: updated.timezone,
      inputs: { enrollmentId, ownerSubject },
      metadata: { enrollmentId, purpose: 'kicktodo-reminder' },
      rosterId: kickbot.rosterId,
      agentId: KICKBOT_AGENT_ID,
    });
    if (!res.ok) log.warn('kicktodo_reminder_job_failed', { enrollmentId, error: res.error.message });
  } else {
    await setJobEnabled(jobId, false); // null when never armed — fine
  }
  return updated;
}

/** ADR 0432 — every enrollment in the tenant (ONE bounded prefix scan).
 *  Exported by the OWNER so the metrics projection never opens a second
 *  handle on this keyspace. Admin-scoped callers only. */
export async function listEnrollmentsInTenant(tenantId: string): Promise<ChallengeEnrollment[]> {
  return await enrollments.listByPrefix(`${tenantId}::`);
}

export async function listEnrollmentsFor(tenantId: string, ownerSubject: string): Promise<ChallengeEnrollment[]> {
  const rows = await enrollments.listByPrefix(`${tenantId}::`);
  return rows.filter((e) => e.ownerSubject === ownerSubject).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Idempotently materialize the occurrences (and their deterministic board
 * cards) due on `dateLocal` for one enrollment. Relies on the pinned Kanban
 * semantics (B1): same-board re-create returns the prior card; a cross-board
 * collision fails closed.
 */
export async function materializeOccurrences(
  tenantId: string,
  enrollId: string,
  dateLocal?: string,
): Promise<KickTodoActionOccurrence[]> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e || e.state !== 'active') return [];
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  if (!challenge) return [];
  const date = dateLocal ?? localDateIn(e.timezone);
  // ADR 0443 R2 → ADR 0496 D1 — the ONE day↔date mapping, now override-aware
  // (`dueDaysOn`): a non-allowed/no-due date yields [] (nothing materializes ⇒
  // never "missed"); a moved day fires ONLY at its override date; two days may
  // legitimately share one date.
  const days = new Set(dueDaysOn(e, challenge.durationDays, date));
  if (days.size === 0) return [];
  const due = challenge.activities.filter((a) => days.has(a.day));
  // The one-live-card invariant across revisions: an activity that already has
  // a LIVE occurrence for this date under ANY revision (e.g. completed under a
  // prior revision and therefore not superseded) is never re-materialized.
  const live = new Set((await occurrencesOn(tenantId, e.id, date)).map((o) => o.stableActivityId));
  const out: KickTodoActionOccurrence[] = [];
  for (const a of due) {
    if (live.has(a.stableActivityId) && !(await occurrences.get(`${tenantId}::${e.id}::${date}::${a.stableActivityId}::r${e.planRevision}`))) {
      continue; // live under a prior revision — do not duplicate
    }
    const cardId = occurrenceCardId(e.id, date, a.stableActivityId, e.planRevision);
    const key = `${tenantId}::${e.id}::${date}::${a.stableActivityId}::r${e.planRevision}`;
    let occ = await occurrences.get(key);
    if (!occ) {
      occ = {
        cardId,
        tenantId,
        enrollmentId: e.id,
        challengeVersion: e.challengeVersion,
        stableActivityId: a.stableActivityId,
        occurrenceDateLocal: date,
        planRevision: e.planRevision,
        evidencePolicy: a.evidencePolicy,
        createdAt: nowIso(),
      };
      await occurrences.put(occ);
    }
    // Card create is idempotent per B1; a repair pass recreates a missing card.
    await createCard({
      boardId: e.boardId,
      columnId: 'todo',
      title: `Day ${a.day}: ${a.title}`,
      description: a.instructions,
      source: 'workflow',
      sourceLabel: 'KickTodo',
      cardId,
    });
    out.push(occ);
  }
  return out;
}

/** ADR 0429 P2 — how far back a missed-window sweep looks. Bounded BY DESIGN:
 *  the sweep reads at most this many per-DATE prefixes (a handful of rows
 *  each) instead of scanning the whole enrollment. */
export const MISSED_LOOKBACK_DAYS = 7;

/** Default collapse cap — beyond this many missed days the plan is not
 *  "recoverable in one action" and the enrollment should be surfaced, not
 *  quietly patched (ADR 0429 open question 1). */
export const COLLAPSE_CAP_DAYS = 3;

export function shiftDate(dateLocal: string, deltaDays: number): string {
  const d = new Date(`${dateLocal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** The strictest evidence policy among the collapsed days — a recovery action
 *  never LOWERS the bar the missed days carried. */
export function strictestPolicy(policies: readonly EvidencePolicy[]): EvidencePolicy {
  return policies.reduce((best, p) => (EVIDENCE_RANK[p] > EVIDENCE_RANK[best] ? p : best), policies[0] ?? 'attestation');
}

/** ADR 0429 P2 — write the ONE collapsed recovery occurrence + its card.
 *  Idempotent by construction: the recovery rides the SAME deterministic key
 *  and card-id scheme as any other activity (synthetic `recovery::<date>` id),
 *  so supersession, freeze, and the card seam need no special-casing.
 *
 *  MISSED-DAY DETECTION LIVES WITH THE CHECK-IN OWNER (`todayService`) — this
 *  module owns occurrences and is not allowed to read check-ins (that edge
 *  would be a cycle AND a second reader of another store's keyspace). */
export async function materializeRecoveryOccurrence(
  tenantId: string,
  enrollId: string,
  input: { firstMissedDateLocal: string; missedCount: number; policies: readonly EvidencePolicy[] },
): Promise<KickTodoActionOccurrence | null> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e || e.state !== 'active') return null;
  const today = localDateIn(e.timezone);
  const activityId = recoveryActivityId(input.firstMissedDateLocal);
  const key = `${tenantId}::${e.id}::${today}::${activityId}::r${e.planRevision}`;
  const existing = await occurrences.get(key);
  const cardId = occurrenceCardId(e.id, today, activityId, e.planRevision);
  const occ: KickTodoActionOccurrence = existing ?? {
    cardId,
    tenantId,
    enrollmentId: e.id,
    challengeVersion: e.challengeVersion,
    stableActivityId: activityId,
    occurrenceDateLocal: today,
    planRevision: e.planRevision,
    evidencePolicy: strictestPolicy(input.policies),
    createdAt: nowIso(),
  };
  if (!existing) await occurrences.put(occ);
  await createCard({
    boardId: e.boardId,
    columnId: 'todo',
    title: `Recovery: get back on track (${input.missedCount} missed)`,
    description: 'One step to re-enter the plan. Missed days are not failures — this closes the gap.',
    source: 'workflow',
    sourceLabel: 'KickTodo',
    cardId,
  });
  log.info('kicktodo_recovery_materialized', { enrollmentId: e.id, missed: input.missedCount });
  return occ;
}

/** ADR 0429 P2 — record that the `ask` policy already prompted for this missed
 *  window, so a re-fired loop never re-asks. Point-write, no new store. */
export async function markMissedWindowAsked(tenantId: string, enrollId: string, firstMissedDateLocal: string): Promise<void> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e) return;
  await enrollments.put({ ...e, missedWindowAskedFor: firstMissedDateLocal });
}

/** ADR 0496 D1 — a typed move-lane refusal; the reason is the message so the
 *  replan command wrapper surfaces it verbatim with the failing index. */
export class DayMoveDeniedError extends Error {
  constructor(public readonly reason:
    | 'bad-day' | 'bad-date' | 'window' | 'past-day' | 'checked-in' | 'not-found') {
    super(reason);
    this.name = 'DayMoveDeniedError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const shiftIso = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** ADR 0496 D1 — guards for moving challenge day `dayIndex` to `toDate`,
 *  shared VERBATIM by the apply lane (`setDayOverride`) and the preview
 *  dry-run (architect M5: one path, so preview can never pass what apply
 *  refuses). Throws `DayMoveDeniedError`; returns the day's natural date. */
export async function assertDayMoveAllowed(
  tenantId: string,
  e: ChallengeEnrollment,
  dayIndex: number,
  toDate: string,
): Promise<{ naturalDate: string; fromDate: string }> {
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  if (!challenge) throw new DayMoveDeniedError('not-found');
  if (!Number.isInteger(dayIndex) || dayIndex < 1 || dayIndex > challenge.durationDays) {
    throw new DayMoveDeniedError('bad-day');
  }
  if (!ISO_DATE.test(toDate) || !Number.isFinite(Date.parse(`${toDate}T00:00:00Z`))) {
    throw new DayMoveDeniedError('bad-date');
  }
  const today = localDateIn(e.timezone);
  // The window: never the past (recovery's jurisdiction), never before the
  // start, never past the natural end + 14 days (a plan may breathe, not
  // dissolve — ADR 0496 D1).
  if (toDate < e.startDateLocal || toDate < today) throw new DayMoveDeniedError('window');
  const naturalEnd = mapDayToDate(e.startDateLocal, e.schedulePreference?.daysOfWeek, challenge.durationDays);
  if (toDate > shiftIso(naturalEnd, 14)) throw new DayMoveDeniedError('window');
  // Architect H1 — the day's LIVE occurrences at their current EFFECTIVE
  // date: one in the past means the day is already missed (moving it would
  // silently erase it from missed-window detection); a terminal card means
  // completed history, which is never rewritten.
  const daySet = new Set(challenge.activities.filter((a) => a.day === dayIndex).map((a) => a.stableActivityId));
  const live = (await occurrences.listByPrefix(`${tenantId}::${e.id}::`))
    .filter((o) => o.supersededByRevision === undefined && daySet.has(o.stableActivityId));
  for (const o of live) {
    if (o.occurrenceDateLocal < today) throw new DayMoveDeniedError('past-day');
    const card = await getCard(o.cardId);
    const board = card ? await getBoard(card.boardId) : null;
    if (card && board?.columns.find((c) => c.id === card.columnId)?.terminal) {
      throw new DayMoveDeniedError('checked-in');
    }
  }
  return {
    naturalDate: mapDayToDate(e.startDateLocal, e.schedulePreference?.daysOfWeek, dayIndex),
    fromDate: effectiveDateForDay(e, dayIndex),
  };
}

/** ADR 0496 D1 — durably move challenge day `dayIndex` to `toDate` (the
 *  participant's own enrollment; the boundary predicate ran upstream, the
 *  owner check here is defence in depth). A move back to the natural date
 *  deletes the override. CAS point-write with the exact read row (the ADR
 *  0447 byte-equality rule); the caller's trailing `applyPlanRevision`
 *  re-materializes today. */
export async function setDayOverride(
  tenantId: string,
  enrollId: string,
  ownerSubject: string,
  dayIndex: number,
  toDate: string,
): Promise<ChallengeEnrollment | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const e = await getEnrollment(tenantId, enrollId);
    if (!e || e.ownerSubject !== ownerSubject || e.state !== 'active') return null;
    const { naturalDate } = await assertDayMoveAllowed(tenantId, e, dayIndex, toDate);
    const overrides: Record<string, string> = { ...(e.schedulePreference?.dayOverrides ?? {}) };
    if (toDate === naturalDate) delete overrides[String(dayIndex)];
    else overrides[String(dayIndex)] = toDate;
    // Merge — a move must never drop daypart/daysOfWeek (the R2-correction rule).
    const pref = {
      ...(e.schedulePreference?.daypart ? { daypart: e.schedulePreference.daypart } : {}),
      ...(e.schedulePreference?.daysOfWeek ? { daysOfWeek: e.schedulePreference.daysOfWeek } : {}),
      ...(Object.keys(overrides).length > 0 ? { dayOverrides: overrides } : {}),
    };
    const next: ChallengeEnrollment = Object.keys(pref).length > 0
      ? { ...e, schedulePreference: pref }
      : { ...e };
    if (Object.keys(pref).length === 0) delete next.schedulePreference;
    if (await enrollments.compareAndSwap(e, next)) return next;
  }
  return await getEnrollment(tenantId, enrollId);
}

/** ADR 0429 P1 — apply a publisher-declared substitution to a LIVE occurrence.
 *  The occurrence key and cardId are unchanged (they embed the PARENT activity
 *  id), so the card, any later check-in, and the frozen evidence snapshot all
 *  stay bound to this row. Refuses: a foreign owner, a superseded occurrence,
 *  an unknown alternative, and — defence in depth behind the publish gate — an
 *  alternative whose evidence policy diverges from the parent's. */
export async function substituteOccurrence(
  tenantId: string,
  actingSubject: string,
  cardId: string,
  alternativeId: string,
): Promise<KickTodoActionOccurrence> {
  const occ = await occurrenceByCard(tenantId, cardId);
  if (!occ) throw new SubstitutionDeniedError('occurrence-not-found');
  if (occ.supersededByRevision !== undefined) throw new SubstitutionDeniedError('superseded');
  const e = await getEnrollment(tenantId, occ.enrollmentId);
  if (!e || e.ownerSubject !== actingSubject) throw new SubstitutionDeniedError('not-owner');
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  const activity: ChallengeActivity | undefined = challenge?.activities.find((a) => a.stableActivityId === occ.stableActivityId);
  const alt = activity?.alternatives?.find((x) => x.stableActivityId === alternativeId);
  if (!activity || !alt) throw new SubstitutionDeniedError('unknown-alternative');
  if (alt.evidencePolicy !== activity.evidencePolicy) throw new SubstitutionDeniedError('evidence-policy-mismatch');
  if (occ.substitutedActivityId === alternativeId) return occ; // idempotent

  const next: KickTodoActionOccurrence = { ...occ, substitutedActivityId: alternativeId };
  await occurrences.put(next);
  // The card is the kanban owner's row — retitle through its UPDATE seam.
  // `createCard` is idempotent-by-id (B1) and deliberately does NOT overwrite
  // an existing card, so a create call here would silently no-op.
  await updateCardFields(cardId, {
    title: `Day ${activity.day}: ${alt.title}`,
    description: alt.instructions,
  });
  log.info('kicktodo_substituted', { enrollmentId: e.id, cardId, alternativeId });
  return next;
}

/** Occurrences for one enrollment on one local date (bounded prefix scan),
 *  excluding superseded rows. */
export async function occurrencesOn(tenantId: string, enrollId: string, dateLocal: string): Promise<KickTodoActionOccurrence[]> {
  const rows = await occurrences.listByPrefix(`${tenantId}::${enrollId}::${dateLocal}::`);
  return rows.filter((o) => o.supersededByRevision === undefined);
}

/** Point-read one occurrence row by its deterministic card id. */
export async function occurrenceByCard(tenantId: string, cardId: string): Promise<KickTodoActionOccurrence | null> {
  // cardId = kicktodo:<enrollmentId>:<localDate>:<stableActivityId>:r<rev>
  const m = /^kicktodo:(enr:[a-f0-9]+):(\d{4}-\d{2}-\d{2}):(.+):r(\d+)$/.exec(cardId);
  if (!m) return null;
  const [, enrollId, date, activityId, rev] = m;
  const o = await occurrences.get(`${tenantId}::${enrollId}::${date}::${activityId}::r${rev}`);
  return o && o.tenantId === tenantId ? o : null;
}

/**
 * PRD §6.3 — the plan-revision transition step. Atomically (per occurrence):
 * mark the prior revision's non-terminal occurrences superseded and DELETE
 * their cards (terminal cards keep history + evidence); then bump the
 * enrollment's `planRevision` and materialize today under the new revision.
 * Exactly one live card per (enrollment, localDate, stableActivityId) across
 * the boundary.
 */
export async function applyPlanRevision(tenantId: string, enrollId: string): Promise<ChallengeEnrollment | null> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e || e.state !== 'active') return e;
  const newRevision = e.planRevision + 1;

  const all = await occurrences.listByPrefix(`${tenantId}::${enrollId}::`);
  for (const occ of all) {
    if (occ.planRevision >= newRevision || occ.supersededByRevision !== undefined) continue;
    const card = await getCard(occ.cardId);
    const board = card ? await getBoard(card.boardId) : null;
    const terminal = !!card && !!board?.columns.find((c) => c.id === card.columnId)?.terminal;
    if (terminal) continue; // completed history is never rewritten
    if (card) await deleteCard(occ.cardId);
    await occurrences.put({ ...occ, supersededByRevision: newRevision });
  }

  const next: ChallengeEnrollment = { ...e, planRevision: newRevision };
  // CAS the bump — a concurrent replan/abandon must not be clobbered (C1-R1).
  if (!(await enrollments.compareAndSwap(e, next))) {
    return await getEnrollment(tenantId, enrollId);
  }
  await materializeOccurrences(tenantId, enrollId);
  log.info('kicktodo_plan_revision', { enrollmentId: enrollId, planRevision: newRevision });
  return next;
}

/** Close an enrollment (client-side abandon; judged completion is C3's
 *  verifier path through the goals owner). Abandons the goal too. */
export async function abandonEnrollment(tenantId: string, enrollId: string, actingSubject: string): Promise<ChallengeEnrollment | null> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e || e.ownerSubject !== actingSubject) return null;
  if (e.state !== 'active' && e.state !== 'snoozed') return e;
  const next: ChallengeEnrollment = { ...e, state: 'abandoned', closedAt: nowIso() };
  // KT-2 (grade-gate fix): CAS — an abandon racing an evaluate projection must
  // not resurrect a stale row; the loser re-reads.
  if (!(await enrollments.compareAndSwap(e, next))) return await getEnrollment(tenantId, enrollId);
  await transitionGoal(tenantId, e.goalId, 'abandon', actingSubject);
  return next;
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
// The occurrence delete key mirrors the collection's `idOf`.
const OCCURRENCE_KEY = (o: KickTodoActionOccurrence): string =>
  `${o.tenantId}::${o.enrollmentId}::${o.occurrenceDateLocal}::${o.stableActivityId}::r${o.planRevision}`;

/** Delete ONE enrollment row + all its occurrences, then fire the lifecycle seam
 *  (best-effort, AFTER the row is gone) so enrollment-keyed rows owned by other
 *  packages can prune without racing the subject-erasure fan-out. The single
 *  enrollment-row delete path — every future deleter routes through here. */
async function deleteEnrollmentRow(tenantId: string, e: ChallengeEnrollment): Promise<void> {
  for (const o of await occurrences.listByPrefix(`${tenantId}::${e.id}::`)) {
    await occurrences.delete(OCCURRENCE_KEY(o));
  }
  await enrollments.delete(`${tenantId}::${e.id}`);
  await fireEnrollmentDeleted({ tenantId, enrollmentId: e.id });
}

/**
 * DSAR erasure: delete the subject's enrollments (each carries `ownerSubject` +
 * `schedulePreference`) and ALL of their materialized occurrences. Returns the
 * deleted enrollment ids so the caller (compliance.ts) can cascade the
 * enrollment-keyed evidence snapshots that have no subject column of their own.
 *
 * Bounded, idempotent, fail-closed on a falsy tenant/subject. Deliberately does
 * NOT touch the participant's Kanban board/cards (host-owned — the kanban feature
 * erases those) nor the scheduler's reminder/daily jobs (host-owned; the remind /
 * materialize / evaluate nodes already self-skip a missing enrollment, so a stale
 * job is an inert no-op, never a fired notification).
 */
export async function eraseSubjectEnrollments(tenantId: string, subjectKey: string): Promise<string[]> {
  if (!tenantId || !subjectKey) return [];
  const mine = (await enrollments.listByPrefix(`${tenantId}::`)).filter((e) => e.ownerSubject === subjectKey);
  const ids: string[] = [];
  for (const e of mine) {
    await deleteEnrollmentRow(tenantId, e);
    ids.push(e.id);
  }
  return ids;
}

/** Test seam. */
export const __test = { enrollments, occurrences };
