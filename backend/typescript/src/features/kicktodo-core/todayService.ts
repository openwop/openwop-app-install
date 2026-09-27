/**
 * Today aggregate + check-ins (ADR 0414 P1; PRD §4.2, §8.4).
 *
 * Today is ONE bounded read: the caller's enrollments (tenant-prefix scan
 * filtered to their subject), each active enrollment's occurrences for its
 * local "today" (per-enrollment/day prefix), and a bounded seven-day recovery
 * preview when its published policy requires a decision. Cards are POINT-loaded
 * by deterministic id — never a cross-tenant card scan, never write-on-GET
 * (materialization is the scheduled/enroll/repair path, not the read path).
 *
 * A check-in is the participant's evidence for one occurrence: recording it
 * moves the deterministic card to the terminal column (the ONE completion
 * signal — PRD §6.3) and appends the CheckIn row. Completion truth stays on
 * the board; the check-in owns evidence; challenge meaning stays on the
 * occurrence.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { getCard, moveCard } from '../../host/kanbanService.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { purgeRowsByAge, type PurgeOutcome } from '../../host/retentionPurger.js';
import { createLogger } from '../../observability/logger.js';
import {
  listEnrollmentsFor,
  occurrenceByCard,
  materializeRecoveryOccurrence,
  markMissedWindowAsked,
  shiftDate,
  MISSED_LOOKBACK_DAYS,
  COLLAPSE_CAP_DAYS,
  occurrencesOn,
  getEnrollment,
} from './enrollmentService.js';
import { getChallenge } from './challengeService.js';
import { progressFor } from './progressService.js';
import { emitKicktodoLifecycle } from './lifecycleEvents.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import {
  effectiveDateForDay,
  localDateIn,
  occurrenceCardId,
  type ChallengeEnrollment,
  type CheckIn,
  type KickTodoActionOccurrence,
} from './types.js';

const log = createLogger('kicktodo.today');

/** Keyed `${tenant}::${enrollmentId}::${cardId}` — ONE check-in per occurrence,
 *  with a bounded per-enrollment prefix for the progress projection (C3). */
const checkIns = new DurableCollection<CheckIn>('kicktodo-checkins', (c) => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`);

// ADR 0458 Phase 0 — a check-in is the participant's evidence for one occurrence:
// `note` is participant free-text (may name/quote people, a photo-ref caption) and
// `measuredValue` is a body measurement — both personal data. Declare them so the
// classification/log-masking + retention machinery (ADR 0077) treats a check-in as
// `confidential-pii` (the tenant-prefixed key makes the retention scan bounded).
declarePiiFields('kicktodo.checkin', ['note', 'measuredValue']);

const CHECKIN_KEY = (c: CheckIn): string => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`;

const nowIso = (): string => new Date().toISOString();

export interface TodayAction {
  occurrence: KickTodoActionOccurrence;
  card: { id: string; title: string; description?: string; columnId: string; completed: boolean } | null;
  checkIn: CheckIn | null;
  /** ADR 0429 P1 — the PUBLISHER-DECLARED alternatives for this action, so the
   *  participant picks from a closed set. Projection only: id + title +
   *  instructions; the evidence policy is the parent's by construction (the
   *  publish gate enforces parity), so it is not repeated here. */
  alternatives: Array<{ stableActivityId: string; title: string; instructions: string }>;
}

export interface TodayView {
  dateLocal: string;
  enrollments: Array<{
    enrollmentId: string;
    challengeId: string;
    challengeVersion: number;
    state: string;
    actions: TodayAction[];
    /** A read-only, bounded preview of a missed window. `offer` can be
     * collapsed into one recovery action; `review` is deliberately past the
     * automatic-collapse cap and must not pretend one action fixes the plan. */
    recovery?: { missed: number; mode: 'offer' | 'review' };
  }>;
}

export async function todayFor(tenantId: string, ownerSubject: string): Promise<TodayView> {
  const mine = await listEnrollmentsFor(tenantId, ownerSubject);
  const active = mine.filter((e) => e.state === 'active');
  const snoozed = mine.filter((e) => e.state === 'snoozed');
  const out: TodayView = { dateLocal: localDateIn((active[0] ?? snoozed[0])?.timezone ?? 'UTC'), enrollments: [] };
  for (const e of active) {
    const date = localDateIn(e.timezone);
    const occs = await occurrencesOn(tenantId, e.id, date);
    // ADR 0429 P1 — ONE challenge read per enrollment (never per action): the
    // alternatives projection must not turn Today into an N+1 (PRD §14).
    const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
    // KT-1: the per-action card + check-in point-loads are independent —
    // resolve them in parallel (bounded by the day's occurrence count) instead
    // of serially.
    const actions: TodayAction[] = await Promise.all(
      occs.map(async (occ) => {
        const [card, ci] = await Promise.all([
          getCard(occ.cardId), // point-load by deterministic id
          checkIns.get(`${tenantId}::${occ.enrollmentId}::${occ.cardId}`),
        ]);
        return {
          occurrence: occ,
          card: card
            ? {
                id: card.id,
                title: card.title,
                description: card.description,
                columnId: card.columnId,
                completed: card.columnId === 'done',
              }
            : null,
          checkIn: ci ?? null,
          alternatives: (challenge?.activities.find((a) => a.stableActivityId === occ.stableActivityId)?.alternatives ?? [])
            .map((alt) => ({ stableActivityId: alt.stableActivityId, title: alt.title, instructions: alt.instructions })),
        };
      }),
    );
    // Read-only recovery preview. The scan is bounded to seven date prefixes,
    // runs only for a policy that can produce a participant decision, and
    // never writes on GET. Once today's deterministic recovery occurrence
    // exists, the prompt disappears and that real action speaks for itself.
    let recovery: { missed: number; mode: 'offer' | 'review' } | undefined;
    const policy = challenge?.missedWindowPolicy ?? 'skip';
    const hasRecoveryAction = occs.some((occ) => occ.stableActivityId.startsWith('recovery::'));
    if (!hasRecoveryAction && (policy === 'ask' || policy === 'collapse-recovery')) {
      const missed = await missedRows(tenantId, e, date);
      if (policy === 'ask' && missed.length > 0) recovery = { missed: missed.length, mode: 'offer' };
      if (policy === 'collapse-recovery' && missed.length > COLLAPSE_CAP_DAYS) {
        recovery = { missed: missed.length, mode: 'review' };
      }
    }
    out.enrollments.push({
      enrollmentId: e.id,
      challengeId: e.challengeId,
      challengeVersion: e.challengeVersion,
      state: e.state,
      actions,
      ...(recovery ? { recovery } : {}),
    });
  }
  // Snoozing is reversible, so Today must keep the resume control reachable.
  // A snoozed enrollment has no actions by definition; projecting the owner’s
  // own row here reveals no additional data and fixes the formerly unreachable
  // frontend recovery state.
  for (const e of snoozed) {
    out.enrollments.push({
      enrollmentId: e.id,
      challengeId: e.challengeId,
      challengeVersion: e.challengeVersion,
      state: e.state,
      actions: [],
    });
  }
  return out;
}

/** ADR 0434 (KTFULL-B6) — the declared evidence policy was never enforced:
 *  an empty body satisfied a `photo` or `measurement` action, so the goals
 *  judge counted completions whose evidence bar was never met. The policy is
 *  copied onto the occurrence at materialization, so it is authoritative here
 *  and needs no challenge re-read. */
export class EvidenceRequiredError extends Error {
  constructor(public readonly policy: string) {
    super(`This action requires ${policy === 'measurement' ? 'a measured value' : policy === 'photo' ? 'a photo reference' : 'a note'}.`);
  }
}

export class CheckInDeniedError extends Error {
  constructor(public readonly reason: 'occurrence-not-found' | 'not-owner' | 'superseded') {
    super(
      reason === 'occurrence-not-found'
        ? 'No such action.'
        : reason === 'not-owner'
          ? 'No such action.' // uniform denial — no existence oracle
          : 'This action was superseded by a plan revision.',
    );
  }
}

/**
 * Record the participant's check-in for one occurrence (idempotent: a repeat
 * submit returns the recorded row untouched — evidence is never overwritten,
 * PRD replay rule) and move the card to the terminal column.
 */
/** ADR 0425 — check-in observers (the enroll-guard inversion, applied to
 *  evidence): downstream features (awards, stats) register at boot; invoked
 *  BEST-EFFORT after the FIRST write only — never on the idempotent-return
 *  path, and a failing observer can never break the check-in itself. */
export type CheckInObserver = (checkIn: CheckIn) => Promise<void>;
const checkInObservers: CheckInObserver[] = [];
export function registerCheckInObserver(o: CheckInObserver): void {
  checkInObservers.push(o);
}
export function __clearCheckInObservers(): void {
  checkInObservers.length = 0;
}

export async function submitCheckIn(
  tenantId: string,
  actingSubject: string,
  cardId: string,
  evidence: { note?: string; measuredValue?: number },
): Promise<CheckIn> {
  const occ = await occurrenceByCard(tenantId, cardId);
  if (!occ) throw new CheckInDeniedError('occurrence-not-found');
  if (occ.supersededByRevision !== undefined) throw new CheckInDeniedError('superseded');
  const e = await getEnrollment(tenantId, occ.enrollmentId);
  if (!e || e.ownerSubject !== actingSubject) throw new CheckInDeniedError('not-owner');

  // ADR 0434 (KTFULL-B6) — enforce the DECLARED evidence policy before any
  // write. `attestation` is satisfied by the act of checking in; every other
  // policy requires its evidence to actually be present.
  const note = evidence.note?.trim();
  switch (occ.evidencePolicy) {
    case 'measurement':
      if (typeof evidence.measuredValue !== 'number' || !Number.isFinite(evidence.measuredValue)) {
        throw new EvidenceRequiredError('measurement');
      }
      break;
    case 'photo':
      // A photo rides the note field as a media reference until a dedicated
      // media binding exists; an empty one is not evidence.
      if (!note) throw new EvidenceRequiredError('photo');
      break;
    case 'note':
      if (!note) throw new EvidenceRequiredError('note');
      break;
    default:
      break; // attestation — checking in IS the attestation
  }

  const existing = await checkIns.get(`${tenantId}::${occ.enrollmentId}::${cardId}`);
  if (existing) return existing; // idempotent — recorded evidence wins

  const ci: CheckIn = {
    cardId,
    tenantId,
    enrollmentId: occ.enrollmentId,
    ownerSubject: actingSubject,
    ...(evidence.note !== undefined ? { note: evidence.note } : {}),
    ...(evidence.measuredValue !== undefined ? { measuredValue: evidence.measuredValue } : {}),
    createdAt: nowIso(),
  };
  await checkIns.put(ci);

  // Completion signal: the deterministic card enters the terminal column.
  const card = await getCard(cardId);
  if (card && card.columnId !== 'done') {
    await moveCard(cardId, 'done');
    // ADR 0456 P2 — if THIS check-in completed the whole challenge, signal CDP
    // (consent-gated + deduped once per enrollment; only recomputed on a NEW
    // activity completion, never on a re-check-in). Best-effort.
    const prog = await progressFor(tenantId, occ.enrollmentId);
    if (prog && prog.completedActivities >= prog.totalRequiredActivities) {
      await emitKicktodoLifecycle(tenantId, e.ownerSubject, 'completed', { challengeId: e.challengeId, challengeVersion: e.challengeVersion });
    }
  }
  for (const o of checkInObservers) {
    try {
      await o(ci);
    } catch (err) {
      log.warn('kicktodo_check_in_observer_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info('kicktodo_check_in', { enrollmentId: occ.enrollmentId, cardId });
  return ci;
}

/** Check-ins for one enrollment (bounded: used by C3's progress projection). */
export async function listCheckIns(tenantId: string, enrollmentId: string): Promise<CheckIn[]> {
  const rows = await checkIns.listByPrefix(`${tenantId}::${enrollmentId}::`);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── ADR 0458 Phase 0 — compliance (subject erasure + time-based retention) ──
// Check-ins carry the participant's `ownerSubject` directly, so DSAR erasure is a
// bounded tenant-prefix scan filtered to the subject (no enrollment lookup needed —
// this also reaches an orphaned check-in whose enrollment was already deleted, and
// is idempotent). Composed into the ONE kicktodo-core subject-eraser (compliance.ts).

/** DSAR erasure: delete every check-in this tenant holds for the subject. No-op on
 *  a falsy tenant/subject; idempotent. Returns the count removed. */
export async function eraseSubjectCheckIns(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  let removed = 0;
  for (const c of await checkIns.listByPrefix(`${tenantId}::`)) {
    if (c.tenantId === tenantId && c.ownerSubject === subjectKey) {
      if (await checkIns.delete(CHECKIN_KEY(c))) removed += 1;
    }
  }
  return removed;
}

/** Time-based retention (ADR 0077 seam): delete this tenant's check-ins whose
 *  natural timestamp (`createdAt` — a check-in is immutable, so there is no
 *  `updatedAt`) is strictly older than the cutoff. Bounded tenant-prefix scan;
 *  fail-closed on a falsy tenant. */
export async function purgeCheckInsByAge(tenantId: string, cutoffIso: string): Promise<PurgeOutcome> {
  return purgeRowsByAge('kicktodo-core', await checkIns.listByPrefix(`${tenantId}::`), tenantId, cutoffIso,
    (c) => ({ tenantId: c.tenantId, updatedAt: c.createdAt, id: CHECKIN_KEY(c) }),
    (id) => checkIns.delete(id));
}

export interface PlanItem {
  enrollmentId: string;
  challengeId: string;
  dateLocal: string;
  day: number;
  stableActivityId: string;
  title: string;
  /** True only when a real check-in exists (past/today truth); the future is a
   *  DERIVED plan, never asserted as fact. */
  completed: boolean;
}

/**
 * ADR 0443 R3 — the cross-challenge Plan view (deck slide 10): upcoming + recent
 * dated actions across the caller's ACTIVE enrollments. A DERIVED, bounded read
 * (no store): dates come from the ONE R2 mapping (`mapDayToDate` — the same
 * function the materializer inverts), completion from real check-ins only.
 * Window capped at 31 days; self-data only.
 */
export async function planFor(
  tenantId: string,
  ownerSubject: string,
  fromLocal: string,
  toLocal: string,
): Promise<PlanItem[]> {
  const from = Date.parse(`${fromLocal}T00:00:00Z`);
  const to = Date.parse(`${toLocal}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  if (to - from > 31 * 86_400_000) return []; // bounded window — refuse silently-huge scans
  const mine = (await listEnrollmentsFor(tenantId, ownerSubject)).filter((e) => e.state === 'active');
  const out: PlanItem[] = [];
  for (const e of mine) {
    const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
    if (!challenge) continue;
    const done = new Set((await listCheckIns(tenantId, e.id)).filter((c) => c.ownerSubject === ownerSubject).map((c) => c.cardId));
    for (const a of challenge.activities) {
      // ADR 0496 D1 — override-aware: a moved day projects at its moved date.
      const dateLocal = effectiveDateForDay(e, a.day);
      const ms = Date.parse(`${dateLocal}T00:00:00Z`);
      if (ms < from || ms > to) continue;
      out.push({
        enrollmentId: e.id,
        challengeId: e.challengeId,
        dateLocal,
        day: a.day,
        stableActivityId: a.stableActivityId,
        title: a.title,
        completed: done.has(occurrenceCardId(e.id, dateLocal, a.stableActivityId, e.planRevision)),
      });
    }
  }
  return out.sort((a, b) => a.dateLocal.localeCompare(b.dateLocal) || a.title.localeCompare(b.title));
}

export interface JournalEntry {
  cardId: string;
  enrollmentId: string;
  challengeId: string;
  note?: string;
  measuredValue?: number;
  createdAt: string;
}

/**
 * ADR 0443 R5 — the participant's own journal: every check-in that carries
 * evidence (a note or a measured value) across ALL their enrollments, newest
 * first. SELF-data only (the caller's `ownerSubject`); bounded by the
 * participant's own enrollment count (the Progress-page fan-out posture) and a
 * hard cap. A read projection over the check-in owner — no new store.
 */
export async function journalFor(tenantId: string, ownerSubject: string, limit = 200): Promise<JournalEntry[]> {
  const mine = await listEnrollmentsFor(tenantId, ownerSubject);
  const all: JournalEntry[] = [];
  for (const e of mine) {
    const rows = await listCheckIns(tenantId, e.id);
    for (const c of rows) {
      if (c.ownerSubject !== ownerSubject) continue; // defense in depth
      if (c.note === undefined && c.measuredValue === undefined) continue;
      all.push({
        cardId: c.cardId,
        enrollmentId: e.id,
        challengeId: e.challengeId,
        ...(c.note !== undefined ? { note: c.note } : {}),
        ...(c.measuredValue !== undefined ? { measuredValue: c.measuredValue } : {}),
        createdAt: c.createdAt,
      });
    }
  }
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(limit, 500)));
}

// ── ADR 0429 P2 — missed-window policy (detection lives HERE because it needs
// check-ins; the occurrence WRITE lives with the occurrence owner) ──────────

interface MissedRow { occurrence: KickTodoActionOccurrence; dateLocal: string }

/** Live, un-checked-in occurrences on PAST dates inside the bounded look-back.
 *  A missed RECOVERY never breeds another recovery. */
async function missedRows(tenantId: string, e: ChallengeEnrollment, todayLocal: string): Promise<MissedRow[]> {
  const out: MissedRow[] = [];
  for (let back = MISSED_LOOKBACK_DAYS; back >= 1; back -= 1) {
    const date = shiftDate(todayLocal, -back);
    if (date < e.startDateLocal) continue;
    for (const occ of await occurrencesOn(tenantId, e.id, date)) {
      if (occ.stableActivityId.startsWith('recovery::')) continue;
      if (await checkIns.get(`${tenantId}::${e.id}::${occ.cardId}`)) continue;
      out.push({ occurrence: occ, dateLocal: date });
    }
  }
  return out;
}

/**
 * Apply the challenge's missed-window policy for one enrollment (PRD §13).
 * Called by the daily loop AFTER materialization; never on a GET (the PRD's
 * no-write-on-read rule). Every path is idempotent.
 */
export async function applyMissedWindowPolicy(
  tenantId: string,
  enrollId: string,
): Promise<{ policy: string; missed: number; recoveryCardId?: string; asked?: boolean }> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e || e.state !== 'active') return { policy: 'skip', missed: 0 };
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  const policy = challenge?.missedWindowPolicy ?? 'skip';
  if (policy === 'skip') return { policy, missed: 0 };

  const today = localDateIn(e.timezone);
  const missed = await missedRows(tenantId, e, today);
  if (missed.length === 0) return { policy, missed: 0 };
  const first = missed[0]!;

  if (policy === 'ask') {
    if (e.missedWindowAskedFor === first.dateLocal) return { policy, missed: missed.length, asked: false };
    await markMissedWindowAsked(tenantId, e.id, first.dateLocal);
    try {
      await getNotificationEmitter().emit({
        tenantId,
        recipientUserId: e.ownerSubject,
        type: 'task.assigned',
        priority: 'normal',
        title: 'Pick up where you left off?',
        message: `${missed.length} action${missed.length === 1 ? '' : 's'} went by. Recover them in one step, or skip ahead — both are fine.`,
        actionUrl: '/kicktodo/today',
        metadata: { category: 'kicktodo-recovery', enrollmentId: e.id, firstMissedDate: first.dateLocal },
      });
    } catch (err) {
      log.warn('kicktodo_missed_window_ask_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    return { policy, missed: missed.length, asked: true };
  }

  // collapse-recovery: past the cap the plan stopped working — surface it
  // rather than quietly patching over a longer absence.
  if (missed.length > COLLAPSE_CAP_DAYS) {
    // ADR 0456 P2 (stalled) — the 4th lifecycle event: off-track past the cap.
    // Consent-gated (no-op without a linked Contact) + deduped once per
    // (subject,challenge,version); best-effort. Feeds a CDP re-engagement journey.
    await emitKicktodoLifecycle(tenantId, e.ownerSubject, 'stalled', { challengeId: e.challengeId, challengeVersion: e.challengeVersion });
    return { policy, missed: missed.length };
  }
  const occ = await materializeRecoveryOccurrence(tenantId, e.id, {
    firstMissedDateLocal: first.dateLocal,
    missedCount: missed.length,
    policies: missed.map((m) => m.occurrence.evidencePolicy),
  });
  return { policy, missed: missed.length, ...(occ ? { recoveryCardId: occ.cardId } : {}) };
}

/** The participant answered YES to an `ask` prompt (or asked for recovery
 *  directly). Idempotent — the recovery key is deterministic. */
export async function acceptRecovery(
  tenantId: string,
  actingSubject: string,
  enrollId: string,
): Promise<KickTodoActionOccurrence | null> {
  const e = await getEnrollment(tenantId, enrollId);
  if (!e || e.ownerSubject !== actingSubject) throw new CheckInDeniedError('not-owner');
  const today = localDateIn(e.timezone);
  const missed = await missedRows(tenantId, e, today);
  if (missed.length === 0) return null;
  return await materializeRecoveryOccurrence(tenantId, e.id, {
    firstMissedDateLocal: missed[0]!.dateLocal,
    missedCount: missed.length,
    policies: missed.map((m) => m.occurrence.evidencePolicy),
  });
}
