/**
 * kicktodo-engagement (ADR 0425) — opt-in leaderboard, deterministic awards,
 * and variant-stamp effectiveness reads.
 *
 * PRIVACY LAW (ADR 0419, applied): no one APPEARS on a board without an
 * explicit opt-in row; what is visible is a CLOSED projection — displayName +
 * completedCount + rank, never notes/measured values/instructions. Opt-out is
 * immediate (filtered on read). The board renders only at k ≥ 3 opted-in
 * members; below the floor the caller sees themself alone.
 *
 * ADR 0641 decision 13 — a board is scoped to ONE CHALLENGE, and LOOKING at it
 * is gated on ENROLMENT while APPEARING on it stays gated on the opt-in. Those
 * are two consents with two owners; see `leaderboard()` for why merging them is
 * the failure decision 10 was withdrawn for.
 *
 * READ COST: `leaderboard()` does NOT read the cached `stats` rows — they are
 * per-SUBJECT totals across every enrollment, the wrong denominator for a
 * per-challenge board. It pays one bounded tenant prefix scan plus, per member,
 * a point get and one tight per-enrollment check-in scan. The stat rows are
 * still maintained by the check-in observer via RECOMPUTE-FROM-SOURCE
 * (idempotent: concurrent double-fires converge) for `variantEffectiveness`,
 * which IS a tenant-wide question.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import { getEnrollment, listEnrollmentsFor, listEnrollmentsInTenant } from '../kicktodo-core/enrollmentService.js';
import { listCheckIns } from '../kicktodo-core/todayService.js';
import { enqueueKickbotCoachTurn } from '../kicktodo-core/kickbotCoachTurnService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { isNotificationMuted } from '../../host/notificationPolicy.js';
import type { CheckIn } from '../kicktodo-core/types.js';
import { progressFor } from '../kicktodo-core/progressService.js';

const log = createLogger('kicktodo.engagement');

export interface LeaderboardOptIn {
  tenantId: string;
  ownerSubject: string;
  displayName: string;
  optedInAt: string;
  revokedAt?: string;
}

const optIns = new DurableCollection<LeaderboardOptIn>(
  'kicktodo-leaderboard-optins',
  (o) => `${o.tenantId}::${o.ownerSubject}`,
);

interface LeaderboardStat {
  tenantId: string;
  ownerSubject: string;
  completedCount: number;
  updatedAt: string;
}

const stats = new DurableCollection<LeaderboardStat>(
  'kicktodo-leaderboard-stats',
  (s) => `${s.tenantId}::${s.ownerSubject}`,
);

export interface KicktodoAward {
  tenantId: string;
  ownerSubject: string;
  /** Deterministic: `${kind}::${enrollmentId}` — a re-evaluation never duplicates. */
  awardId: string;
  kind: 'first-check-in' | 'streak-7' | 'streak-30' | 'challenge-complete' | 'comeback';
  enrollmentId: string;
  earnedAt: string;
}

const awards = new DurableCollection<KicktodoAward>(
  'kicktodo-awards',
  (a) => `${a.tenantId}::${a.ownerSubject}::${a.awardId}`,
);

const nowIso = (): string => new Date().toISOString();

export class OptInRequiredError extends Error {
  constructor() {
    super('Join the leaderboard first.');
  }
}

/** ADR 0641 decision 13 — the LOOK gate. Distinct from `OptInRequiredError`,
 *  which is the APPEAR gate: this one means "you are not in this challenge",
 *  the other means "you are not consenting to be ranked". Collapsing them would
 *  tell a non-participant whether a challenge has a board, and would re-merge
 *  the two consents decision 13 deliberately separates. */
export class NotEnrolledError extends Error {
  constructor() {
    super('Enroll in this challenge to see its leaderboard.');
  }
}

export async function optIn(tenantId: string, ownerSubject: string, displayName: string): Promise<LeaderboardOptIn> {
  const name = displayName.trim().slice(0, 60);
  if (!name) throw new OptInRequiredError();
  const row: LeaderboardOptIn = { tenantId, ownerSubject, displayName: name, optedInAt: nowIso() };
  await optIns.put(row);
  await refreshStats(tenantId, ownerSubject); // seed the stat row so a new member ranks immediately
  // GC-2 — consent lifecycle. Tenant only: the subject is opaque and must not
  // be logged, and displayName is user free text (hard no).
  log.info('kicktodo_leaderboard_opt_in', { tenantId });
  return row;
}

export async function optOut(tenantId: string, ownerSubject: string): Promise<void> {
  const row = await optIns.get(`${tenantId}::${ownerSubject}`);
  if (row && !row.revokedAt) {
    await optIns.put({ ...row, revokedAt: nowIso() });
    log.info('kicktodo_leaderboard_opt_out', { tenantId });
  }
}

export async function myOptIn(tenantId: string, ownerSubject: string): Promise<LeaderboardOptIn | null> {
  const row = await optIns.get(`${tenantId}::${ownerSubject}`);
  return row && !row.revokedAt ? row : null;
}

/** Recompute a subject's completion total from SOURCE (check-ins across their
 *  enrollments) and overwrite the stat row. Idempotent by construction. */
export async function refreshStats(tenantId: string, ownerSubject: string): Promise<number> {
  const enrollments = await listEnrollmentsFor(tenantId, ownerSubject);
  let completed = 0;
  for (const e of enrollments) completed += (await listCheckIns(tenantId, e.id)).length;
  await stats.put({ tenantId, ownerSubject, completedCount: completed, updatedAt: nowIso() });
  return completed;
}

export interface LeaderboardEntry {
  displayName: string;
  completedCount: number;
  rank: number;
  you: boolean;
}

export interface LeaderboardView {
  entries: LeaderboardEntry[];
  /** True when the k ≥ 3 floor is unmet — the caller sees only themself. */
  belowFloor: boolean;
}

const K_FLOOR = 3;

/**
 * One challenge's board (ADR 0641 decision 13).
 *
 * TWO INDEPENDENT GATES, and keeping them independent is the point:
 *
 *   - **Enrolment gates who may LOOK.** A caller with no enrollment in this
 *     challenge gets `NotEnrolledError`; peers' standings are not public to the
 *     rest of the tenant.
 *   - **The opt-in gates who APPEARS.** An enrolled participant who never opted
 *     in can read the board without being ranked on it.
 *
 * Folding them into one check is the failure ADR 0641 decision 10 was withdrawn
 * for: enrolment answers "may this session look" (membership), the opt-in
 * answers "may this row appear" (consent to be ranked). They are different
 * questions with different owners, and `optIn`/`optOut` remain the only writers
 * of the second. This previously gated LOOKING on the opt-in, which made
 * "I want to see the board" and "I consent to be ranked" the same act.
 *
 * SCOPE: tenant-wide previously, so participants of DIFFERENT challenges shared
 * one board and `completedCount` summed check-ins across all of a subject's
 * enrollments. Both halves had to move together — scoping the roster alone would
 * leave a board that looks challenge-specific and ranks on unrelated work.
 *
 * COST: one bounded tenant prefix scan for the roster, then per member a point
 * get (opt-in) plus one TIGHT `${tenant}::${enrollment}::` check-in scan. The
 * cached `stats` rows are deliberately NOT read here — they are per-SUBJECT
 * totals, which is the wrong denominator for a per-challenge board. `refreshStats`
 * still maintains them for the tenant-wide experiment aggregation below.
 *
 * The projection stays CLOSED — displayName, completedCount, rank; nothing else.
 */
export async function leaderboard(
  tenantId: string,
  callerSubject: string,
  challengeId: string,
): Promise<LeaderboardView> {
  const enrolledInTenant = await listEnrollmentsInTenant(tenantId);
  const forChallenge = enrolledInTenant.filter((e) => e.challengeId === challengeId);

  // LOOK gate — membership, not consent.
  if (!forChallenge.some((e) => e.ownerSubject === callerSubject)) throw new NotEnrolledError();

  // APPEAR gate — consent, not membership. A subject may hold MORE THAN ONE
  // enrollment in the same challenge (`deriveEnrollmentId` keys on version, so
  // re-enrolling at a new version mints a second row); their work on this
  // challenge is the sum, counted once per subject.
  const bySubject = new Map<string, { subject: string; displayName: string; completedCount: number }>();
  for (const e of forChallenge) {
    const opt = await optIns.get(`${tenantId}::${e.ownerSubject}`);
    if (!opt || opt.revokedAt) continue;
    const completed = (await listCheckIns(tenantId, e.id)).length;
    const prior = bySubject.get(e.ownerSubject);
    if (prior) prior.completedCount += completed;
    else bySubject.set(e.ownerSubject, { subject: e.ownerSubject, displayName: opt.displayName, completedCount: completed });
  }

  const rows = [...bySubject.values()];
  rows.sort((a, b) => b.completedCount - a.completedCount || a.displayName.localeCompare(b.displayName));
  // k-anonymity floor. A challenge-scoped board is SMALLER than the tenant-wide
  // one it replaces, so this trips more often — that is the floor working, not a
  // regression. A caller who is enrolled but not opted in is not in `rows`, so
  // the self-only fallback correctly shows them an empty board.
  const belowFloor = rows.length < K_FLOOR;
  const visible = belowFloor ? rows.filter((r) => r.subject === callerSubject) : rows;
  return {
    belowFloor,
    entries: visible.map((r, i) => ({
      displayName: r.displayName,
      completedCount: r.completedCount,
      rank: belowFloor ? 1 : i + 1,
      you: r.subject === callerSubject,
    })),
  };
}

/** UTC day-stamps of a sorted check-in list → the current streak ending at the
 *  LAST check-in day (calendar-consecutive, duplicates collapsed). */
/** Day-stamp an ISO instant in the ENROLLMENT's timezone (grade-pass ENG-1:
 *  UTC day boundaries mis-bucket streaks for non-UTC participants). */
function dayStampIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10); // unknown tz — fall back to UTC
  }
}

function trailingStreak(checkIns: CheckIn[], timeZone: string): number {
  const days = [...new Set(checkIns.map((c) => dayStampIn(c.createdAt, timeZone)))].sort();
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (i === days.length - 1) { streak = 1; continue; }
    const gap = (Date.parse(days[i + 1]) - Date.parse(days[i])) / 86_400_000;
    if (gap === 1) streak += 1;
    else break;
  }
  return streak;
}

/** ADR 0425 P2 — derive awards for one check-in (the observer body).
 *  Deterministic ids ⇒ a re-evaluation writes the same rows (idempotent). */
export async function evaluateAwards(ci: CheckIn): Promise<KicktodoAward[]> {
  const earned: KicktodoAward[] = [];
  const put = async (kind: KicktodoAward['kind']) => {
    const award: KicktodoAward = {
      tenantId: ci.tenantId,
      ownerSubject: ci.ownerSubject,
      awardId: `${kind}::${ci.enrollmentId}`,
      kind,
      enrollmentId: ci.enrollmentId,
      earnedAt: nowIso(),
    };
    const key = `${award.tenantId}::${award.ownerSubject}::${award.awardId}`;
    if (!(await awards.get(key))) {
      await awards.put(award);
      earned.push(award);
    }
  };
  const all = await listCheckIns(ci.tenantId, ci.enrollmentId);
  if (all.length >= 1) await put('first-check-in');
  const enrollment = await getEnrollment(ci.tenantId, ci.enrollmentId);
  const timeZone = enrollment?.timezone ?? 'UTC';
  const streak = trailingStreak(all, timeZone);
  if (streak >= 7) await put('streak-7');
  if (streak >= 30) await put('streak-30');
  // Comeback: today's check-in after a gap of ≥3 calendar days.
  const days = [...new Set(all.map((c) => dayStampIn(c.createdAt, timeZone)))].sort();
  if (days.length >= 2) {
    const gap = (Date.parse(days[days.length - 1]) - Date.parse(days[days.length - 2])) / 86_400_000;
    if (gap >= 3) await put('comeback');
  }
  // Challenge complete: every required activity has evidence.
  const progress = await progressFor(ci.tenantId, ci.enrollmentId);
  if (progress && progress.completedActivities >= progress.totalRequiredActivities) await put('challenge-complete');
  if (earned.length) log.info('kicktodo_awards_earned', { kinds: earned.map((a) => a.kind) });
  return earned;
}

export async function listAwards(tenantId: string, ownerSubject: string): Promise<KicktodoAward[]> {
  return await awards.listByPrefix(`${tenantId}::${ownerSubject}::`);
}

/** The observer registered at feature boot: derive awards, then refresh the
 *  subject's stat row (both idempotent; both best-effort at the seam). */
export async function onCheckIn(ci: CheckIn): Promise<void> {
  const earned = await evaluateAwards(ci);
  await refreshStats(ci.tenantId, ci.ownerSubject);
  await celebrateAwards(ci, earned);
}

const AWARD_TITLES: Record<KicktodoAward['kind'], string> = {
  'first-check-in': 'First check-in',
  'streak-7': 'Seven days in a row',
  'streak-30': 'Thirty days in a row',
  'comeback': 'Welcome back',
  'challenge-complete': 'Challenge complete',
};

/** ADR 0689 — an earned award is ANNOUNCED, not just stored: one addressed
 *  notification per award plus one proactive KickBot turn in the participant's
 *  own 1:1 (the coach-turn seam is per-award idempotent). Mute / quiet hours
 *  are consulted here, by the producer (ADR 0457). Best-effort at the observer
 *  seam — a notification or scheduler hiccup never fails the check-in. */
export async function celebrateAwards(ci: CheckIn, earned: readonly KicktodoAward[]): Promise<void> {
  for (const award of earned) {
    try {
      if (!(await isNotificationMuted(ci.tenantId, ci.ownerSubject, { type: 'kicktodo.award-earned', priority: 'normal' }))) {
        await getNotificationEmitter().emit({
          tenantId: ci.tenantId,
          recipientUserId: ci.ownerSubject,
          type: 'kicktodo.award-earned',
          priority: 'normal',
          title: AWARD_TITLES[award.kind],
          message: 'You earned a new award. Your guide has something to say about it.',
          actionUrl: '/kicktodo/progress',
          metadata: { category: 'kicktodo-award', kind: award.kind, enrollmentId: award.enrollmentId },
        });
      }
    } catch (err) {
      log.warn('kicktodo_award_notify_failed', { kind: award.kind, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      await enqueueKickbotCoachTurn(ci.tenantId, { ownerSubject: ci.ownerSubject, enrollmentId: award.enrollmentId, occasion: 'award', awardKind: award.kind });
    } catch (err) {
      log.warn('kicktodo_award_coach_turn_failed', { kind: award.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** ADR 0425 P3 — counts-only effectiveness read: completion totals grouped by
 *  the caller-resolved toggle variant (deterministic bucketing via resolveOne;
 *  no stored assignment row). Tenant-scoped; counts only. */
export async function effectivenessByVariant(
  tenantId: string,
  resolveVariant: (subject: string) => Promise<string>,
): Promise<Record<string, { members: number; completed: number }>> {
  const live = (await optIns.listByPrefix(`${tenantId}::`)).filter((o) => !o.revokedAt);
  const out: Record<string, { members: number; completed: number }> = {};
  for (const o of live) {
    const variant = await resolveVariant(o.ownerSubject);
    out[variant] ??= { members: 0, completed: 0 };
    out[variant].members += 1;
    out[variant].completed += (await stats.get(`${tenantId}::${o.ownerSubject}`))?.completedCount ?? 0;
  }
  return out;
}

// ADR 0458 P0 — GDPR data-subject erasure (subjectErasure seam). Every store in this
// package is keyed by `ownerSubject` and holds the SUBJECT's own personal data: the
// opt-in row carries their free-text `displayName`, the stat row their completion total,
// the award rows their achievements. On a DSAR, delete all three for the subject —
// leaderboard membership, ranking, and badges vanish together. Tenant-scoped (the key
// embeds the tenant, so a foreign tenant's rows never match), idempotent (delete no-ops
// on an absent row), no notifications.
export async function eraseEngagementSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  await optIns.delete(`${tenantId}::${subjectKey}`);
  await stats.delete(`${tenantId}::${subjectKey}`);
  for (const a of await awards.listByPrefix(`${tenantId}::${subjectKey}::`)) {
    await awards.delete(`${a.tenantId}::${a.ownerSubject}::${a.awardId}`);
  }
}
registerSubjectEraser(eraseEngagementSubject);

// NO registerRetentionPurger (deliberate — the CRM-model choice to OMIT with a reason):
// none of these rows are aged `confidential-pii`. Opt-ins are a CONSENT lifecycle (removed
// on opt-out / DSAR, never by age); stats are a DERIVED projection recomputed from source;
// awards are immutable achievement records the subject earned. There is nothing here that
// is an abandoned free-text-PII record aged on `updatedAt` (the contact/comment model), so
// this package is not consulted by the time-based sweep.

/** Test-only: the module-private collections, for erasure/seed assertions. */
export const __test = { optIns, stats, awards };
