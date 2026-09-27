/**
 * kicktodo-core domain types (ADR 0414 §Decision; PRD §6).
 *
 * Single sources of truth (PRD §6.1–§6.4): the CHALLENGE structure lives here
 * (published rows immutable + content-addressed); ACTION state lives on the
 * subject-owned Kanban board; the OCCURRENCE row carries challenge meaning for
 * one deterministic card; the CHECK-IN owns submitted evidence; the durable
 * OUTCOME lives in the ADR 0412 goals owner (one goal per enrollment). All
 * records are host-private (no wire schema; PRD §17 — a portable challenge
 * shape would be an RFC).
 */

import { createHash } from 'node:crypto';

export type EvidencePolicy = 'attestation' | 'note' | 'photo' | 'measurement';

/** ADR 0429 — a publisher-declared alternative for one activity. Substitution
 *  is NEVER free-form: a participant may only pick an option the publisher
 *  declared, or the factory's outcome→achievement→evidence traceability
 *  (PRD §7.3) silently voids. The unstructured lane is the check-in note. */
export interface ChallengeAlternative {
  /** Unique within the parent activity; never equal to the parent's own id. */
  stableActivityId: string;
  title: string;
  instructions: string;
  /** MUST equal the parent activity's policy — the occurrence COPIES the
   *  policy at materialization, so a divergent alternative would leave the
   *  occurrence asserting an evidence bar the participant never met. */
  evidencePolicy: EvidencePolicy;
}

export interface ChallengeActivity {
  /** Stable within the challenge across versions (deterministic card ids key on it). */
  stableActivityId: string;
  /** 1-based day index within the challenge. */
  day: number;
  title: string;
  instructions: string;
  estimatedMinutes?: number;
  evidencePolicy: EvidencePolicy;
  /** ADR 0429 P1 — publisher-declared substitutions. Part of the immutable
   *  published body, so they are inside `contentHash` and replay-stable. */
  alternatives?: ChallengeAlternative[];
  /** ADR 0458 §2.2 (correction, 2026-09-15) — ids of the research claims this
   *  day's copy relies on (`ResearchClaim.claimId` in the candidate's dossier).
   *  Provenance for the participant-facing text: the factory writes it from the
   *  validated plan, `validatePlan` refuses an id the dossier does not know, and
   *  it is inside `contentHash` like the rest of the body. Absent on drafts
   *  authored without a dossier (the manual creator lane). */
  claimRefs?: string[];
}

/** ADR 0429 P2 — what a challenge does when a day is missed (PRD §13).
 *  ABSENT means `skip`, so every already-published version keeps its exact
 *  meaning and its contentHash stays valid — no artifact migration. */
export type MissedWindowPolicy = 'skip' | 'collapse-recovery' | 'ask';

/** Evidence strictness order — a collapsed recovery action inherits the
 *  STRICTEST policy among the days it absorbs (never lowers the bar). */
export const EVIDENCE_RANK: Readonly<Record<EvidencePolicy, number>> = {
  attestation: 0,
  note: 1,
  photo: 2,
  measurement: 3,
};

/** The synthetic activity id a collapsed recovery occurrence carries. It rides
 *  the SAME occurrence key + card-id scheme as any other activity, so
 *  supersession, freeze, and the card seam need no special-casing. */
export function recoveryActivityId(firstMissedDateLocal: string): string {
  return `recovery::${firstMissedDateLocal}`;
}

export type ChallengeStatus = 'draft' | 'published' | 'retired';

export interface ChallengeDefinition {
  id: string;
  version: number;
  status: ChallengeStatus;
  tenantId: string;
  /** Stable authoring subject (opaque; RFC 0048 posture — never an email). */
  authorSubject?: string;
  title: string;
  summary: string;
  outcome: string;
  durationDays: number;
  activities: ChallengeActivity[];
  /** ADR 0429 P2 — absent means `skip` (today's behaviour). */
  missedWindowPolicy?: MissedWindowPolicy;
  /** ADR 0430 — BCP-47 content locale. Absent reads as `en` (legacy rows), so
   *  no artifact migration. Deliberately NOT inside `challengeContentHash`:
   *  the enrollment STAMPS that hash and the frozen evidence snapshot embeds
   *  the stamped value, so changing the covered field set would make freshly
   *  computed hashes disagree with stamped ones. A translation carries a
   *  different `id` (which IS covered), so translations hash differently by
   *  construction; a mislabeled locale is caught by the publish gate. */
  contentLocale?: string;
  /** ADR 0443 R4 — the deck slide-5 content-depth facet (Discover filter +
   *  Detail chip). Absent = unlabeled (honest for pre-existing content).
   *  Deliberately NOT inside `contentHash` — the same stamped-hash reasoning as
   *  `contentLocale` above: enrollments stamp the hash, so widening the covered
   *  field set would make fresh hashes disagree with stamped ones. */
  depthLevel?: 'beginner' | 'intermediate' | 'advanced';
  /** ADR 0430 — lineage: the IMMUTABLE source version this was translated
   *  from. A translation is its own challenge ID with its own version axis —
   *  never another version of the source's lineage, because version numbers
   *  mean "content revision" and overloading them with locale would make
   *  "latest version" meaningless and break per-locale retirement. */
  translationOf?: { challengeId: string; version: number };
  /** Content hash over the published, immutable body. Absent on drafts. */
  contentHash?: string;
  createdAt: string;
  publishedAt?: string;
}

export type EnrollmentState = 'active' | 'snoozed' | 'completed' | 'abandoned' | 'escalated';

export interface ChallengeEnrollment {
  /** ADR 0429 P2 — the first-missed date the `ask` policy last prompted for.
   *  Point-write on the existing row (no new store): materialization can be
   *  invoked by both the saga and the workflow surface, so the participant is
   *  asked ONCE per missed window, not once per invocation. */
  missedWindowAskedFor?: string;
  id: string;
  tenantId: string;
  /** The participant's stable opaque subject (owner; mutations are theirs). */
  ownerSubject: string;
  challengeId: string;
  challengeVersion: number;
  challengeContentHash: string;
  state: EnrollmentState;
  /** ADR 0412 owner — ONE bounded goal per enrollment. */
  goalId: string;
  /** The participant's ONE deterministic KickTodo board. */
  boardId: string;
  /** Monotonic plan revision — deterministic occurrence/card ids include it;
   *  an approved re-plan bumps it THROUGH applyPlanRevision (which supersedes
   *  the prior revision's non-terminal cards first — the PRD §6.3 invariant). */
  planRevision: number;
  /** IANA timezone the daily cadence is computed in. */
  timezone: string;
  /** Local date (YYYY-MM-DD, in `timezone`) of day 1. */
  startDateLocal: string;
  /** ADR 0443 R1/R2 — the participant's schedule preference.
   *  `daypart` (R1): the OPT-IN reminder rhythm — freely changeable, reminder-only.
   *  `daysOfWeek` (R2): the allowed weekdays (0=Sun..6=Sat) the challenge's days
   *  map onto — ENROLL-TIME ONLY and immutable afterward (the mapping inputs must
   *  stay frozen or day indices drift; a mid-flight change is the KickBot re-plan
   *  lane, ADR 0443 OQ1). Absent = every day (today's semantics). */
  schedulePreference?: {
    daypart?: 'morning' | 'afternoon' | 'evening';
    daysOfWeek?: number[];
    /** ADR 0496 D1 — per-day date overrides (the `move` lane): key = the
     *  1-based challenge day (stringified), value = the explicit local date it
     *  was moved to. Consulted by BOTH halves of the R2 mapping via
     *  `effectiveDateForDay`/`dueDaysOn`; a move back to the natural date
     *  deletes its key (no tombstones). */
    dayOverrides?: Record<string, string>;
  };
  /** ADR 0444 I1 — ATTRIBUTION ONLY: the opaque subject whose invite link this
   *  enrollment came through. Grants nothing (no scopes, no circle membership);
   *  stamped at enroll from a resolved live token, never caller-asserted. */
  invitedBy?: string;
  createdAt: string;
  closedAt?: string;
}

export interface KickTodoActionOccurrence {
  /** Deterministic — ALSO the Kanban card id (PRD §6.3). */
  cardId: string;
  tenantId: string;
  enrollmentId: string;
  challengeVersion: number;
  stableActivityId: string;
  occurrenceDateLocal: string;
  planRevision: number;
  evidencePolicy: EvidencePolicy;
  /** ADR 0429 P1 — the publisher-declared alternative the participant chose.
   *  The occurrence KEY and cardId are unchanged (they embed the PARENT
   *  activity id), so the card, the check-in, and the frozen evidence
   *  snapshot all stay bound to the same row. */
  substitutedActivityId?: string;
  /** Set when a later plan revision superseded this occurrence (its non-terminal
   *  card was removed); the row is kept for audit/history. */
  supersededByRevision?: number;
  createdAt: string;
}

export interface CheckIn {
  /** One check-in per occurrence — keyed by the deterministic card id. */
  cardId: string;
  tenantId: string;
  enrollmentId: string;
  ownerSubject: string;
  /** Attestation is always true when submitted; note/value are optional evidence. */
  note?: string;
  measuredValue?: number;
  createdAt: string;
}

/** Deterministic occurrence/card id (PRD §6.3):
 *  `(enrollmentId, localDate, stableActivityId, planRevision)`. */
export function occurrenceCardId(
  enrollmentId: string,
  localDate: string,
  stableActivityId: string,
  planRevision: number,
): string {
  return `kicktodo:${enrollmentId}:${localDate}:${stableActivityId}:r${planRevision}`;
}

/** Deterministic enrollment id — repeat enrollment in the same challenge
 *  version by the same participant is the SAME enrollment (idempotent saga). */
export function enrollmentId(tenantId: string, ownerSubject: string, challengeId: string, version: number): string {
  const h = createHash('sha256').update(`${tenantId}|${ownerSubject}|${challengeId}|${version}`).digest('hex').slice(0, 24);
  return `enr:${h}`;
}

/** The participant's ONE deterministic KickTodo action board. */
export function participantBoardId(tenantId: string, ownerSubject: string): string {
  const h = createHash('sha256').update(`${tenantId}|${ownerSubject}`).digest('hex').slice(0, 24);
  return `kicktodo-board:${h}`;
}

/** Content hash over the immutable published challenge body. */
export function challengeContentHash(c: Pick<ChallengeDefinition, 'id' | 'version' | 'title' | 'summary' | 'outcome' | 'durationDays' | 'activities'>): string {
  const body = JSON.stringify({
    id: c.id,
    version: c.version,
    title: c.title,
    summary: c.summary,
    outcome: c.outcome,
    durationDays: c.durationDays,
    activities: c.activities,
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

/** ADR 0430 — the effective content locale of a challenge row (absent ⇒ `en`). */
export function contentLocaleOf(c: Pick<ChallengeDefinition, 'contentLocale'>): string {
  return c.contentLocale ?? 'en';
}

/** ADR 0430 — negotiate ONE row from a lineage for a requested content locale:
 *  exact match → same-language match (`pt-BR` → `pt`) → the source. Pure, so
 *  it is test-pinnable and callable from the single catalog scan (no N+1). */
export function negotiateLocale<T extends Pick<ChallengeDefinition, 'contentLocale' | 'translationOf'>>(
  lineage: readonly T[],
  requested: string,
): { row: T; servedLocale: string; exact: boolean } | null {
  if (lineage.length === 0) return null;
  const want = requested.trim().toLowerCase();
  const lang = want.split('-')[0] ?? want;
  const exact = lineage.find((r) => contentLocaleOf(r).toLowerCase() === want);
  if (exact) return { row: exact, servedLocale: contentLocaleOf(exact), exact: true };
  const sameLang = lineage.find((r) => (contentLocaleOf(r).toLowerCase().split('-')[0] ?? '') === lang);
  if (sameLang) return { row: sameLang, servedLocale: contentLocaleOf(sameLang), exact: false };
  const source = lineage.find((r) => r.translationOf === undefined) ?? lineage[0]!;
  return { row: source, servedLocale: contentLocaleOf(source), exact: false };
}

/** YYYY-MM-DD in the given IANA timezone. */
export function localDateIn(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** 1-based challenge day number for `dateLocal` given day 1 = `startDateLocal`.
 *  Both are YYYY-MM-DD; the difference is calendar days (timezone-neutral once
 *  both dates are already local). */
export function dayNumber(startDateLocal: string, dateLocal: string): number {
  const start = Date.parse(`${startDateLocal}T00:00:00Z`);
  const day = Date.parse(`${dateLocal}T00:00:00Z`);
  return Math.floor((day - start) / 86_400_000) + 1;
}

/** ADR 0443 R2 — the ONE day↔date mapping (materializer inverse + the Plan view's
 *  forward projection both use this pair; a round-trip property test pins them).
 *  Pure over enroll-time-frozen inputs (startDateLocal + daysOfWeek), so it is
 *  deterministic + replay-safe by construction. Absent/empty daysOfWeek = every
 *  day (identical to `dayNumber`'s semantics). */
const DAY_MS = 86_400_000;
const isoAt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const allowed = (daysOfWeek: number[] | undefined, ms: number): boolean =>
  !daysOfWeek || daysOfWeek.length === 0 || daysOfWeek.includes(new Date(ms).getUTCDay());

/** The local DATE challenge day `dayIndex` (1-based) falls on: the dayIndex-th
 *  allowed date on/after `startDateLocal`. */
export function mapDayToDate(startDateLocal: string, daysOfWeek: number[] | undefined, dayIndex: number): string {
  let ms = Date.parse(`${startDateLocal}T00:00:00Z`);
  let remaining = dayIndex;
  // Bounded walk: at most dayIndex weeks past the start (≥1 allowed day/week).
  for (let guard = 0; guard < dayIndex * 7 + 7; guard++) {
    if (allowed(daysOfWeek, ms)) {
      remaining -= 1;
      if (remaining === 0) return isoAt(ms);
    }
    ms += DAY_MS;
  }
  return isoAt(ms); // unreachable with valid inputs (validated at enroll)
}

/** The enrollment slice the override-aware mapping needs (ADR 0496 D1). */
export interface ScheduleShape {
  startDateLocal: string;
  schedulePreference?: { daysOfWeek?: number[]; dayOverrides?: Record<string, string> } | undefined;
}

/** ADR 0496 D1 — the OVERRIDE-AWARE forward mapping: the local date challenge
 *  day `dayIndex` actually falls on. This (with `dueDaysOn`) is the reachable
 *  API for enrollment-dated math; the raw `mapDayToDate`/`dayNumberFor` pair
 *  below stays the pure natural mapping the pair's property test pins — new
 *  callers use THESE so a `move` can never be silently bypassed. */
export function effectiveDateForDay(e: ScheduleShape, dayIndex: number): string {
  const override = e.schedulePreference?.dayOverrides?.[String(dayIndex)];
  return override ?? mapDayToDate(e.startDateLocal, e.schedulePreference?.daysOfWeek, dayIndex);
}

/** ADR 0496 D1 — the OVERRIDE-AWARE inverse: every challenge day due on
 *  `dateLocal`. Multiplicity is the point: a moved day fires ONLY at its
 *  override date (never also at its natural date), and two days may share a
 *  date. Bounded by `durationDays` (small by construction). */
export function dueDaysOn(e: ScheduleShape, durationDays: number, dateLocal: string): number[] {
  const overrides = e.schedulePreference?.dayOverrides ?? {};
  const out: number[] = [];
  const natural = dayNumberFor(e.startDateLocal, e.schedulePreference?.daysOfWeek, dateLocal);
  if (natural !== null && natural <= durationDays && overrides[String(natural)] === undefined) out.push(natural);
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== dateLocal) continue;
    const d = Number(k);
    if (Number.isInteger(d) && d >= 1 && d <= durationDays && !out.includes(d)) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

/** The challenge day index due on `dateLocal`, or null when the date is before
 *  the start or not an allowed weekday (a non-allowed day materializes nothing,
 *  so it is never "missed"). */
export function dayNumberFor(startDateLocal: string, daysOfWeek: number[] | undefined, dateLocal: string): number | null {
  const start = Date.parse(`${startDateLocal}T00:00:00Z`);
  const target = Date.parse(`${dateLocal}T00:00:00Z`);
  if (target < start) return null;
  if (!allowed(daysOfWeek, target)) return null;
  let n = 0;
  for (let ms = start; ms <= target; ms += DAY_MS) {
    if (allowed(daysOfWeek, ms)) n += 1;
  }
  return n;
}
