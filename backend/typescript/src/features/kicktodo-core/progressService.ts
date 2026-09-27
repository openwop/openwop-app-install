/**
 * Progress projection + frozen evidence + the goal verifier (ADR 0414 P3;
 * PRD §6.5, §8.4).
 *
 * PROGRESS is a projection over board-card state, check-ins, and the goal —
 * rebuildable, never an independent truth (PRD principle 5).
 *
 * EVIDENCE is FROZEN before judging: `freezeProgressEvidence` snapshots the
 * per-occurrence completion refs + metrics into an immutable, content-hashed
 * row (`kicktodo.progress-evidence` — the opaque ref+hash contract decided in
 * ADR 0412). The judge never re-reads mutable live collections.
 *
 * THE VERIFIER registered under `kicktodo:progress-evidence` (the ref every
 * enrollment goal declares) resolves the snapshot by ref, RE-HASHES it to
 * prove integrity (tamper ⇒ typed failure, never a verdict), and judges
 * DETERMINISTICALLY: satisfied ⇔ every required activity of the pinned
 * challenge version has a completed occurrence. Rubric/LLM judgment is the
 * Challenge Factory's lane (ADR 0415), not the participant loop's.
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { purgeRowsByAge, type PurgeOutcome } from '../../host/retentionPurger.js';
import { createLogger } from '../../observability/logger.js';
import { getCard } from '../../host/kanbanService.js';
import { registerGoalVerifier } from '../goals/goalVerifiers.js';
import { evaluateGoal, getGoal } from '../goals/goalsService.js';
import { getChallenge } from './challengeService.js';
import { getEnrollment, __test as enrollmentStore } from './enrollmentService.js';
import { listCheckIns } from './todayService.js';
import type { ChallengeEnrollment, EnrollmentState } from './types.js';

const log = createLogger('kicktodo.progress');

export interface ProgressEvidenceSnapshot {
  /** `ev:<sha256-prefix>` — the opaque snapshotRef handed to goals. */
  id: string;
  tenantId: string;
  enrollmentId: string;
  challengeId: string;
  challengeVersion: number;
  challengeContentHash: string;
  planRevision: number;
  asOf: string;
  totalRequiredActivities: number;
  completedActivities: number;
  checkInCount: number;
  /** Per-occurrence completion refs (ids only — content-free). */
  occurrences: Array<{ cardId: string; stableActivityId: string; completed: boolean; checkedInAt?: string }>;
  /** sha256 over the canonical judgeable body — the goals `snapshotHash`. */
  snapshotHash: string;
}

/** Keyed `${tenant}::${enrollmentId}::${id}` — immutable append-only rows. */
const evidence = new DurableCollection<ProgressEvidenceSnapshot>(
  'kicktodo-evidence',
  (s) => `${s.tenantId}::${s.enrollmentId}::${s.id}`,
);

const nowIso = (): string => new Date().toISOString();

function canonicalBody(s: Omit<ProgressEvidenceSnapshot, 'id' | 'snapshotHash'>): string {
  return JSON.stringify({
    tenantId: s.tenantId,
    enrollmentId: s.enrollmentId,
    challengeId: s.challengeId,
    challengeVersion: s.challengeVersion,
    challengeContentHash: s.challengeContentHash,
    planRevision: s.planRevision,
    totalRequiredActivities: s.totalRequiredActivities,
    completedActivities: s.completedActivities,
    checkInCount: s.checkInCount,
    occurrences: s.occurrences,
  });
}

/** One §5.6 trace row — the participant's own record of one materialized
 *  action: what it was, when it fell, whether it happened, and whether it was
 *  a RECOVERY action (recovery is part of the plan, never framed as failure). */
export interface ProgressTraceRow {
  stableActivityId: string;
  /** The plan day (from the challenge definition); null for recovery rows —
   *  they belong to a date, not a plan day. */
  day: number | null;
  /** Activity title; null when the activity no longer resolves in the
   *  challenge definition (shown honestly as unresolved, never fabricated). */
  title: string | null;
  recovery: boolean;
  dateLocal: string;
  completed: boolean;
  checkedInAt?: string;
}

export interface ProgressView {
  enrollmentId: string;
  state: EnrollmentState;
  goalState: string | null;
  currentDay: number;
  durationDays: number;
  totalRequiredActivities: number;
  completedActivities: number;
  checkInCount: number;
  /** §5.6 — the evidence trace, ordered by date then plan day. */
  trace: ProgressTraceRow[];
  /** §5.6 — real recovery state (store-backed `recovery::` occurrences),
   *  distinguished from failure by construction. */
  recovery: { offered: number; completed: number };
}

/** Live (non-superseded) occurrences with their completion state. */
async function liveOccurrenceStates(tenantId: string, e: ChallengeEnrollment) {
  const rows = (await enrollmentStore.occurrences.listByPrefix(`${tenantId}::${e.id}::`)).filter(
    (o) => o.supersededByRevision === undefined,
  );
  const out: Array<{ cardId: string; stableActivityId: string; completed: boolean; checkedInAt?: string; occurrenceDateLocal: string }> = [];
  const checkIns = await listCheckIns(tenantId, e.id);
  const ciByCard = new Map(checkIns.map((c) => [c.cardId, c.createdAt]));
  for (const o of rows) {
    const card = await getCard(o.cardId);
    const completed = card?.columnId === 'done';
    const at = ciByCard.get(o.cardId);
    out.push({
      cardId: o.cardId,
      stableActivityId: o.stableActivityId,
      completed,
      ...(at !== undefined ? { checkedInAt: at } : {}),
      occurrenceDateLocal: o.occurrenceDateLocal,
    });
  }
  return out;
}

/** The rebuildable progress projection (PRD §6.5). */
export async function progressFor(tenantId: string, enrollmentId: string): Promise<ProgressView | null> {
  const e = await getEnrollment(tenantId, enrollmentId);
  if (!e) return null;
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  if (!challenge) return null;
  const occ = await liveOccurrenceStates(tenantId, e);
  const completedByActivity = new Set(occ.filter((o) => o.completed).map((o) => o.stableActivityId));
  const goal = await getGoal(tenantId, e.goalId);
  const today = new Date().toISOString().slice(0, 10);
  const day = Math.max(1, Math.min(challenge.durationDays, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.startDateLocal}T00:00:00Z`)) / 86_400_000) + 1));
  // §5.6 — the trace: every live occurrence joined to its plan activity
  // (title/day), recovery rows flagged by their `recovery::` id. A row whose
  // activity no longer resolves keeps a null title (honest, not fabricated).
  const byActivity = new Map(challenge.activities.map((a) => [a.stableActivityId, a]));
  const trace: ProgressTraceRow[] = occ
    .map((o) => {
      const recovery = o.stableActivityId.startsWith('recovery::');
      const activity = recovery ? undefined : byActivity.get(o.stableActivityId);
      return {
        stableActivityId: o.stableActivityId,
        day: activity?.day ?? null,
        title: activity?.title ?? null,
        recovery,
        dateLocal: o.occurrenceDateLocal,
        completed: o.completed,
        ...(o.checkedInAt !== undefined ? { checkedInAt: o.checkedInAt } : {}),
      };
    })
    .sort((a, b) => (a.dateLocal < b.dateLocal ? -1 : a.dateLocal > b.dateLocal ? 1 : (a.day ?? 99) - (b.day ?? 99)));
  const recoveryRows = trace.filter((r) => r.recovery);
  return {
    enrollmentId: e.id,
    state: e.state,
    goalState: goal?.state ?? null,
    currentDay: day,
    durationDays: challenge.durationDays,
    totalRequiredActivities: challenge.activities.length,
    completedActivities: completedByActivity.size,
    checkInCount: (await listCheckIns(tenantId, e.id)).length,
    trace,
    recovery: { offered: recoveryRows.length, completed: recoveryRows.filter((r) => r.completed).length },
  };
}

/** Freeze the current progress into an immutable, content-hashed snapshot. */
export async function freezeProgressEvidence(tenantId: string, enrollmentId: string): Promise<ProgressEvidenceSnapshot | null> {
  const e = await getEnrollment(tenantId, enrollmentId);
  if (!e) return null;
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  if (!challenge) return null;
  // Snapshot shape is HASHED (canonicalBody) — strip to the frozen legacy row
  // shape explicitly so projection-side additions (the §5.6 trace fields) can
  // never silently change evidence hashing.
  const occurrences = (await liveOccurrenceStates(tenantId, e)).map(
    ({ cardId, stableActivityId, completed, checkedInAt }) => ({
      cardId,
      stableActivityId,
      completed,
      ...(checkedInAt !== undefined ? { checkedInAt } : {}),
    }),
  );
  const completedByActivity = new Set(occurrences.filter((o) => o.completed).map((o) => o.stableActivityId));
  const base: Omit<ProgressEvidenceSnapshot, 'id' | 'snapshotHash'> = {
    tenantId,
    enrollmentId: e.id,
    challengeId: e.challengeId,
    challengeVersion: e.challengeVersion,
    challengeContentHash: e.challengeContentHash,
    planRevision: e.planRevision,
    asOf: nowIso(),
    totalRequiredActivities: challenge.activities.length,
    completedActivities: completedByActivity.size,
    checkInCount: (await listCheckIns(tenantId, e.id)).length,
    occurrences,
  };
  const hash = `sha256:${createHash('sha256').update(canonicalBody(base)).digest('hex')}`;
  const snapshot: ProgressEvidenceSnapshot = { ...base, id: `ev:${hash.slice(7, 31)}`, snapshotHash: hash };
  // Immutable: same content ⇒ same id/hash ⇒ idempotent put of an identical row.
  await evidence.put(snapshot);
  return snapshot;
}

export async function getEvidence(tenantId: string, enrollmentId: string, id: string): Promise<ProgressEvidenceSnapshot | null> {
  const s = await evidence.get(`${tenantId}::${enrollmentId}::${id}`);
  return s && s.tenantId === tenantId ? s : null;
}

// ── ADR 0458 Phase 0 — compliance (subject erasure + time-based retention) ──
// A frozen evidence snapshot is a per-subject behavioural record (completion refs +
// judge hashes) held under an enrollment. It has no `ownerSubject` column, so DSAR
// erasure is keyed by the subject's ENROLLMENT ids (resolved in compliance.ts before
// the enrollment rows are deleted) — snapshots delete by the `${tenant}::${enrollmentId}::`
// prefix. Classified `confidential-pii` for the age-based sweep (behavioural personal
// data, even though the refs are content-free ids).

const EVIDENCE_KEY = (s: ProgressEvidenceSnapshot): string => `${s.tenantId}::${s.enrollmentId}::${s.id}`;

/** DSAR erasure: delete every frozen evidence snapshot under the given enrollments.
 *  Idempotent; a falsy tenant / empty id-set is a no-op. Returns the count removed. */
export async function eraseEvidenceForEnrollments(tenantId: string, enrollmentIds: readonly string[]): Promise<number> {
  if (!tenantId || enrollmentIds.length === 0) return 0;
  let removed = 0;
  for (const enrollmentId of enrollmentIds) {
    for (const s of await evidence.listByPrefix(`${tenantId}::${enrollmentId}::`)) {
      if (await evidence.delete(EVIDENCE_KEY(s))) removed += 1;
    }
  }
  return removed;
}

/** Time-based retention (ADR 0077 seam): delete this tenant's evidence snapshots whose
 *  freeze time (`asOf`, immutable — no `updatedAt`) is strictly older than the cutoff.
 *  Bounded tenant-prefix scan; fail-closed on a falsy tenant. */
export async function purgeEvidenceByAge(tenantId: string, cutoffIso: string): Promise<PurgeOutcome> {
  return purgeRowsByAge('kicktodo-core', await evidence.listByPrefix(`${tenantId}::`), tenantId, cutoffIso,
    (s) => ({ tenantId: s.tenantId, updatedAt: s.asOf, id: EVIDENCE_KEY(s) }),
    (id) => evidence.delete(id));
}

/** The deterministic goal verifier (registered at feature boot). */
export const KICKTODO_VERIFIER = 'kicktodo:progress-evidence';

export function registerKicktodoGoalVerifier(): void {
  registerGoalVerifier(KICKTODO_VERIFIER, async ({ goal, evidence: ev }) => {
    // snapshotRef is `<tenant>|<enrollmentId>|<id>` (host-private encoding).
    const [tenantId, enrollmentId, id] = ev.snapshotRef.split('|');
    const snapshot = tenantId && enrollmentId && id ? await getEvidence(tenantId, enrollmentId, id) : null;
    if (!snapshot) throw new Error(`progress-evidence snapshot not found for ref ${ev.snapshotRef}`);
    // Integrity: the stored row must re-hash to the caller-supplied hash —
    // a tampered or mismatched snapshot is a FAILURE, never a verdict.
    const rehash = `sha256:${createHash('sha256').update(canonicalBody(snapshot)).digest('hex')}`;
    if (rehash !== ev.snapshotHash || snapshot.snapshotHash !== ev.snapshotHash) {
      throw new Error('progress-evidence hash mismatch — refusing to judge tampered evidence');
    }
    const satisfied = snapshot.completedActivities >= snapshot.totalRequiredActivities;
    log.info('kicktodo_goal_judged', { goalId: goal.id, enrollmentId: snapshot.enrollmentId, satisfied });
    return {
      satisfied,
      confidence: 1, // deterministic criteria — no model judgment involved
      runId: `run:kicktodo-eval:${snapshot.id.slice(3)}`,
    };
  });
}

export class EnrollmentNotEvaluableError extends Error {}

/**
 * Freeze → judge → project (PRD §8.4): builds the immutable snapshot, hands
 * goals the opaque ref+hash, and projects the goal's verdict back onto the
 * enrollment (`satisfied → completed`; `escalated → escalated`). The GOAL
 * remains the outcome truth; the enrollment state is a coordinated projection
 * (any mismatch is surfaced, not silently reconciled).
 */
export async function evaluateEnrollment(
  tenantId: string,
  enrollmentId: string,
  actingSubject: string,
): Promise<{ enrollment: ChallengeEnrollment; satisfied: boolean; replayed: boolean } | null> {
  const e = await getEnrollment(tenantId, enrollmentId);
  if (!e || e.ownerSubject !== actingSubject) return null;
  const snapshot = await freezeProgressEvidence(tenantId, enrollmentId);
  if (!snapshot) throw new EnrollmentNotEvaluableError('No judgeable state for this enrollment.');
  const result = await evaluateGoal(
    tenantId,
    e.goalId,
    { snapshotRef: `${tenantId}|${enrollmentId}|${snapshot.id}`, snapshotHash: snapshot.snapshotHash },
    actingSubject,
  );
  if (!result) throw new EnrollmentNotEvaluableError('The enrollment goal is missing.');

  let next = e;
  const goalState = result.goal.state;
  const targetState: EnrollmentState | null =
    goalState === 'satisfied' ? 'completed' : goalState === 'escalated' ? 'escalated' : null;
  if (targetState && e.state !== targetState) {
    next = { ...e, state: targetState, closedAt: nowIso() };
    // KT-2 (grade-gate fix): CAS the projection; on a lost race the goal is
    // still the truth — re-read and surface whatever the winner wrote.
    if (!(await enrollmentStore.enrollments.compareAndSwap(e, next))) {
      next = (await getEnrollment(tenantId, enrollmentId)) ?? next;
    }
  }
  return { enrollment: next, satisfied: result.verdict.satisfied, replayed: result.replayed };
}

/** Snooze/resume — recovery is a first-class branch (PRD principle 7): a
 *  snoozed enrollment materializes nothing until resumed; no guilt mechanics. */
export async function setEnrollmentSnooze(
  tenantId: string,
  enrollmentId: string,
  actingSubject: string,
  snoozed: boolean,
): Promise<ChallengeEnrollment | null> {
  const e = await getEnrollment(tenantId, enrollmentId);
  if (!e || e.ownerSubject !== actingSubject) return null;
  if (e.state !== 'active' && e.state !== 'snoozed') return e;
  const target: EnrollmentState = snoozed ? 'snoozed' : 'active';
  if (e.state === target) return e;
  const next: ChallengeEnrollment = { ...e, state: target };
  if (!(await enrollmentStore.enrollments.compareAndSwap(e, next))) {
    return await getEnrollment(tenantId, enrollmentId); // KT-2: lost race → winner's row
  }
  return next;
}
