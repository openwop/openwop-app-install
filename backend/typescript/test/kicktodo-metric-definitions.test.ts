/**
 * KTFULL-B19 — the outcome metrics must mean what PRD §15 says they mean.
 *
 * Three definitions were wrong, and all three biased the numbers UPWARD, so
 * the product would have read as healthier than it was:
 *
 *  1. "meaningful weekly progress" counted ENROLLMENTS, so one person joining
 *     three challenges counted as three people making progress.
 *  2. D7/D30 retention had no UPPER window — any check-in at or after day N-1
 *     counted, so a check-in on day 40 scored as D7-retained. With no ceiling,
 *     retention converges on the completion rate and stops measuring retention.
 *  3. recovery counted GAPS, so one person lapsing four times contributed four
 *     recoveries to a rate that is meant to describe a population.
 *
 * Each expectation below fails against those old definitions.
 *
 * Seeding writes through SECOND HANDLES on the owning collections (same name,
 * same key function) rather than through the services, because these metrics
 * only differ from the old ones at timescales — 40 and 60 days — that the
 * real enrollment path cannot produce in a test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { engagementMetrics } from '../src/features/kicktodo-metrics/metricsService.js';
import type { ChallengeEnrollment, CheckIn } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-metric-defs';
const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');

const enrollments = new DurableCollection<ChallengeEnrollment>(
  'kicktodo-enrollments',
  (e) => `${e.tenantId}::${e.id}`,
);
const checkIns = new DurableCollection<CheckIn>(
  'kicktodo-checkins',
  (c) => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`,
);

async function seed(
  id: string,
  ownerSubject: string,
  createdAtMs: number,
  checkInsAtMs: number[],
): Promise<void> {
  await enrollments.put({
    id, tenantId: T, ownerSubject,
    challengeId: 'ch', challengeVersion: 1, challengeContentHash: 'h',
    state: 'active', goalId: `goal:${id}`, boardId: `board:${id}`,
    planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01',
    createdAt: new Date(createdAtMs).toISOString(),
  });
  // The GC-1 case seeds 200k check-ins. Awaiting each put SEQUENTIALLY made the
  // seed — not the code under test — cost ~21s, which drifted over the 15s
  // testTimeout and read as a flake in full-suite runs. Batching the puts keeps
  // the row count (and therefore the guarantee) identical while spending the
  // time on what the test is actually about.
  const BATCH = 5_000;
  for (let start = 0; start < checkInsAtMs.length; start += BATCH) {
    await Promise.all(checkInsAtMs.slice(start, start + BATCH).map((t, k) => checkIns.put({
      cardId: `${id}::c${start + k}`, tenantId: T, enrollmentId: id, ownerSubject,
      createdAt: new Date(t).toISOString(),
    })));
  }
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('PRD §15 metric definitions', () => {
  it('counts PARTICIPANTS, not enrollments, for the north star', async () => {
    // ONE person, THREE active enrollments, each with a recent check-in.
    await seed('e1', 'user:solo', NOW - 3 * DAY, [NOW - DAY]);
    await seed('e2', 'user:solo', NOW - 3 * DAY, [NOW - DAY]);
    await seed('e3', 'user:solo', NOW - 3 * DAY, [NOW - DAY]);

    const m = await engagementMetrics(T, NOW);
    // The old code reported 3 contributors for one human being.
    expect(m.weeklyMeaningfulProgress.contributors).toBe(1);
  });

  it('does NOT score a much-later check-in as D7 or D30 retention', async () => {
    // Five people, each enrolled 60 days ago with ONE check-in on day 40 —
    // long past both windows. The old predicate counted every one of them as
    // retained at D7 AND D30, giving a perfect 100% retention rate.
    for (let i = 0; i < 5; i += 1) {
      await seed(`late${i}`, `user:late-${i}`, NOW - 60 * DAY, [NOW - 20 * DAY]);
    }
    const m = await engagementMetrics(T, NOW);
    expect(m.retentionD7.contributors).toBe(5); // all eligible — above the k-floor
    expect(m.retentionD7.value).toBe(0);        // and NONE of them retained
    expect(m.retentionD30.value).toBe(0);
  });

  it('scores retention for someone active INSIDE the window', async () => {
    // Same cohort, but checking in on day 7 — genuinely retained.
    for (let i = 0; i < 5; i += 1) {
      await seed(`ok${i}`, `user:ok-${i}`, NOW - 60 * DAY, [NOW - 53 * DAY]);
    }
    const m = await engagementMetrics(T, NOW);
    expect(m.retentionD7.value).toBe(1);
    expect(m.retentionD30.value).toBe(0); // absent from the day-30 window
  });

  it('counts a recovering PARTICIPANT once, however many times they lapsed', async () => {
    // Five people, each with FOUR separate 3-day gaps followed by a return.
    for (let i = 0; i < 5; i += 1) {
      const stamps = [0, 3, 6, 9, 12].map((d) => NOW - (40 - d) * DAY);
      await seed(`lap${i}`, `user:lapser-${i}`, NOW - 45 * DAY, stamps);
    }
    const m = await engagementMetrics(T, NOW);
    // The old code reported 20 contributors (4 gaps x 5 people) for 5 people.
    expect(m.recoveryRate7d.contributors).toBe(5);
    expect(m.recoveryRate7d.value).toBe(1);
  });
});

describe('GC-1 — the metrics path has no unbounded argument spread', () => {
  it('computes the last check-in over an array far past the spread limit', async () => {
    // `Math.max(...stamps)` spreads every check-in as a call ARGUMENT, so a
    // long-lived enrollment threw RangeError and 500'd the metrics route for
    // the WHOLE tenant because one participant had been diligent. 200k is
    // comfortably past the engine's argument ceiling.
    const many = Array.from({ length: 200_000 }, (_, i) => NOW - (200_000 - i) * 60_000);
    await seed('big', 'user:diligent', NOW - 200 * DAY, many);
    await expect(engagementMetrics(T, NOW)).resolves.toBeDefined();
    // An EXPLICIT timeout rather than the 15s global: this test seeds 200k rows
    // by design, so it is legitimately the heaviest in the suite and should not
    // depend on how loaded the machine is. Batching the seed took it from ~21s
    // to ~6s; the headroom here is for contention, not for slow code.
  }, 30_000);
});
