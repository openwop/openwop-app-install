/**
 * kicktodo-metrics (ADR 0432) — PRD §15 outcome metrics as COMPUTED-ON-READ
 * projections over the owning services.
 *
 * NOT a parallel read model: there is no second event stream, no copy of
 * enrollment state, no rollup at rest. Every number is a pure function of the
 * owners' durable state, read through THEIR exported functions — so a metric
 * can never silently disagree with the product.
 *
 * PRIVACY: counts and percentiles only. No participant subject, note, or
 * measured value crosses this boundary, and any cell computed from fewer than
 * K_FLOOR participants is WITHHELD (never rounded down to a small number).
 *
 * SCALE (stated, not hidden): one tenant-prefix enrollment scan plus one
 * per-enrollment check-in prefix scan. Bounded per tenant and fine at Wave-1/2
 * scale; the falsifiable trigger for materializing a nightly rollup is a tenant
 * over ~5k enrollments or a p95 over 2s on these routes.
 */

import { createLogger } from '../../observability/logger.js';
import { listEnrollmentsInTenant } from '../kicktodo-core/enrollmentService.js';
import { listCheckIns } from '../kicktodo-core/todayService.js';
import { listCandidates } from '../kicktodo-creator/creatorService.js';

const log = createLogger('kicktodo.metrics');

/** Below this many contributing participants a cell is WITHHELD entirely. */
export const K_FLOOR = 5;

const DAY_MS = 86_400_000;

function percentile(sortedMs: readonly number[], p: number): number | null {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[idx] ?? null;
}

/** A cell that respects the k-floor: below it, the VALUE is withheld — the
 *  count of contributors is still returned so the caller can say why. */
export interface FlooredCell<T> {
  value: T | null;
  contributors: number;
  withheldReason?: 'below-k-floor';
}

function floored<T>(value: T, contributors: number): FlooredCell<T> {
  return contributors >= K_FLOOR
    ? { value, contributors }
    : { value: null, contributors, withheldReason: 'below-k-floor' };
}

export interface ActivationMetrics {
  /** PRD §15 — median days from enrollment (signup→plan) to the first
   *  COMPLETED action. Null when too few participants contribute. */
  daysToFirstCompletedActionP50: FlooredCell<number>;
  enrollmentsStarted: number;
  enrollmentsWithAnyCompletion: FlooredCell<number>;
}

export interface EngagementMetrics {
  /** THE NORTH STAR (PRD §1/§15): participants with >= 1 completed required
   *  action in the trailing 7 days on an ACTIVE enrollment. Definition is a
   *  named predicate so a redefinition is a failing test, not silent drift. */
  weeklyMeaningfulProgress: FlooredCell<number>;
  retentionD7: FlooredCell<number>;
  retentionD30: FlooredCell<number>;
  completionRate: FlooredCell<number>;
  abandonmentRate: FlooredCell<number>;
  /** Recovered within 7 days of a snooze or a missed day. */
  recoveryRate7d: FlooredCell<number>;
}

export interface FactoryMetrics {
  candidatesByState: Record<string, number>;
  publishRate: FlooredCell<number>;
}

/** PRD §15 activation. */
export async function activationMetrics(tenantId: string, now = Date.now()): Promise<ActivationMetrics> {
  const enrollments = await listEnrollmentsInTenant(tenantId);
  const gaps: number[] = [];
  let withCompletion = 0;
  for (const e of enrollments) {
    const checkIns = await listCheckIns(tenantId, e.id);
    const first = checkIns[0];
    if (!first) continue;
    withCompletion += 1;
    const gap = Date.parse(first.createdAt) - Date.parse(e.createdAt);
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const p50 = percentile(gaps, 50);
  log.info('kicktodo_metrics_activation', { enrollments: enrollments.length, now });
  return {
    enrollmentsStarted: enrollments.length,
    enrollmentsWithAnyCompletion: floored(withCompletion, enrollments.length),
    daysToFirstCompletedActionP50: floored(p50 === null ? 0 : Math.round((p50 / DAY_MS) * 10) / 10, gaps.length),
  };
}

/** PRD §15 engagement + the north star. */
export async function engagementMetrics(tenantId: string, now = Date.now()): Promise<EngagementMetrics> {
  const enrollments = await listEnrollmentsInTenant(tenantId);
  // KTFULL-B19 — the PRD counts PARTICIPANTS ("a participant with >= 1
  // completed required action..."), not enrollments. Counting enrollments
  // inflated every rate by however many challenges a person had joined, so a
  // single enthusiastic user could carry the north star on their own. Every
  // participant-denominated metric below is now a SET of owner subjects.
  const participants = new Set(enrollments.map((e) => e.ownerSubject));
  const total = participants.size;
  const meaningfulSubjects = new Set<string>();
  const aliveD7Subjects = new Set<string>();
  const aliveD30Subjects = new Set<string>();
  const eligibleD7Subjects = new Set<string>();
  const eligibleD30Subjects = new Set<string>();
  let completed = 0;
  let abandoned = 0;
  const gappedSubjects = new Set<string>();
  const recoveredSubjects = new Set<string>();

  for (const e of enrollments) {
    const checkIns = await listCheckIns(tenantId, e.id);
    const stamps = checkIns.map((c) => Date.parse(c.createdAt)).filter((n) => Number.isFinite(n));
    // GC-1 — `Math.max(...stamps)` spreads every check-in as an ARGUMENT, so a
    // long-lived enrollment throws RangeError rather than degrading: the
    // metrics route would 500 for the whole tenant because one participant was
    // diligent. A reduce has no argument-count ceiling.
    const lastCheckIn = stamps.length ? stamps.reduce((a, t) => (t > a ? t : a), stamps[0]!) : null;

    if (e.state === 'completed') completed += 1;
    if (e.state === 'abandoned') abandoned += 1;

    // North star: an ACTIVE enrollment with >= 1 completed action in 7 days.
    if (e.state === 'active' && lastCheckIn !== null && now - lastCheckIn <= 7 * DAY_MS) {
      meaningfulSubjects.add(e.ownerSubject);
    }

    // KTFULL-B19 — DN retention needs an UPPER window. The old predicate
    // ("any check-in at or after day N-1") counted a check-in on day 200 as
    // D7-retained, which makes D7 and D30 monotonically converge on the
    // completion rate and stop measuring retention at all. Retention now asks
    // the real question: was this participant active DURING the day-N window?
    const startedAt = Date.parse(e.createdAt);
    const age = now - startedAt;
    const activeInWindow = (fromDay: number, toDay: number): boolean =>
      stamps.some((t) => t >= startedAt + fromDay * DAY_MS && t < startedAt + toDay * DAY_MS);
    if (age >= 8 * DAY_MS) {
      eligibleD7Subjects.add(e.ownerSubject);
      if (activeInWindow(6, 8)) aliveD7Subjects.add(e.ownerSubject);
    }
    if (age >= 31 * DAY_MS) {
      eligibleD30Subjects.add(e.ownerSubject);
      if (activeInWindow(29, 31)) aliveD30Subjects.add(e.ownerSubject);
    }

    // Recovery (PRD §15): of the participants who LAPSED, how many came back
    // within 7 days?
    //
    // ARCH-H2 — this previously derived gaps only from CONSECUTIVE PAIRS of
    // existing check-ins, so a participant who lapsed and never returned had
    // no trailing pair and never entered the denominator at all. The rate was
    // computed over "lapsed AND returned" only, which made it approach 100%
    // exactly when churn was worst — the opposite of what it must report. An
    // OPEN lapse (a gap between the last check-in and now, on a still-active
    // enrollment) now counts as a lapse with no recovery.
    const sorted = [...stamps].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i]! - sorted[i - 1]!;
      if (gap >= 2 * DAY_MS) {
        // KTFULL-B19 — a PARTICIPANT recovers, a gap does not.
        gappedSubjects.add(e.ownerSubject);
        if (gap <= 7 * DAY_MS) recoveredSubjects.add(e.ownerSubject);
      }
    }
    if (lastCheckIn !== null && e.state === 'active' && now - lastCheckIn >= 2 * DAY_MS) {
      gappedSubjects.add(e.ownerSubject); // lapsed and has NOT come back
    }
  }

  const rate = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num / den) * 1000) / 1000);
  const eligibleD7 = eligibleD7Subjects.size;
  const eligibleD30 = eligibleD30Subjects.size;
  const gapped = gappedSubjects.size;
  // PRD §15 reads challenge completion/abandonment PER CHALLENGE TAKEN, so
  // those two stay enrollment-denominated; everything else is per participant.
  const enrollmentTotal = enrollments.length;
  return {
    // The contributor base is every participant in the tenant (the population
    // the count is drawn FROM), not the count itself — so a small numerator in
    // a large tenant is reported, while a small TENANT is withheld entirely.
    weeklyMeaningfulProgress: floored(meaningfulSubjects.size, total),
    retentionD7: floored(rate(aliveD7Subjects.size, eligibleD7), eligibleD7),
    retentionD30: floored(rate(aliveD30Subjects.size, eligibleD30), eligibleD30),
    // ARCH-H3 — the RATE is per challenge taken (PRD §15), but the k-FLOOR is
    // a disclosure control and must always count HUMANS. Flooring these on the
    // enrollment count published a cell three participants produced whenever
    // they held two enrollments each — precisely the disclosure the floor
    // exists to prevent. Numerator stays enrollment-denominated; the
    // withholding decision is made on `total` participants.
    completionRate: floored(rate(completed, enrollmentTotal), total),
    abandonmentRate: floored(rate(abandoned, enrollmentTotal), total),
    recoveryRate7d: floored(rate(recoveredSubjects.size, gapped), gapped),
  };
}

/** PRD §15 Challenge-Factory quality. */
export async function factoryMetrics(tenantId: string): Promise<FactoryMetrics> {
  const candidates = await listCandidates(tenantId);
  const byState: Record<string, number> = {};
  for (const c of candidates) byState[c.state] = (byState[c.state] ?? 0) + 1;
  const published = byState.published ?? 0;
  return {
    candidatesByState: byState,
    publishRate: floored(candidates.length === 0 ? 0 : Math.round((published / candidates.length) * 1000) / 1000, candidates.length),
  };
}
