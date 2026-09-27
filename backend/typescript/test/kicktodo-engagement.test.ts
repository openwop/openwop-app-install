/**
 * ADR 0425 P1–P3 — engagement:
 *  - leaderboard requires opt-in; below k=3 the caller sees only themself;
 *    at k the closed projection ranks by completions; opt-out is immediate
 *  - awards derive idempotently via the check-in observer (deterministic ids —
 *    a duplicate check-in submission never re-awards)
 *  - effectiveness read returns counts-only buckets by variant
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, registerCheckInObserver, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import {
  optIn, optOut, leaderboard, listAwards, onCheckIn, effectivenessByVariant, NotEnrolledError,
} from '../src/features/kicktodo-engagement/engagementService.js';

const T = 'tenant-engagement';
const subjects = ['user:eng-a', 'user:eng-b', 'user:eng-c'] as const;
const cardBySubject = new Map<string, string>();
let CHAL = '';
let OTHER_CHAL = '';
const OUTSIDER = 'user:eng-outsider';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
  registerCheckInObserver(onCheckIn);
  const draft = await createDraft({
    tenantId: T, title: 'Engage', summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'act', day: 1, title: 'Do the thing', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  CHAL = draft.id;
  for (const s of subjects) {
    await enroll({ tenantId: T, ownerSubject: s, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    const today = await todayFor(T, s);
    cardBySubject.set(s, today.enrollments[0].actions[0].occurrence.cardId);
  }

  // A SECOND challenge in the SAME tenant. Before ADR 0641 decision 13 its
  // participants shared one board with the first challenge's, and their
  // check-ins counted toward the same total — which is what the scoping test
  // below pins.
  const other = await createDraft({
    tenantId: T, title: 'Other', summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'act2', day: 1, title: 'Other thing', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, other.id, 1);
  OTHER_CHAL = other.id;
  await enroll({ tenantId: T, ownerSubject: OUTSIDER, challengeId: other.id, challengeVersion: 1, timezone: 'UTC' });
});

describe('opt-in leaderboard (P1)', () => {
  it('k-floor hides others; ranks by completions; opt-out immediate', async () => {
    // ADR 0641 decision 13 — an ENROLLED caller may LOOK before opting in. They
    // simply are not on the board yet: no rows, so the k-floor holds and the
    // self-only fallback finds nothing of theirs to show.
    const beforeOptIn = await leaderboard(T, subjects[0], CHAL);
    expect(beforeOptIn.belowFloor).toBe(true);
    expect(beforeOptIn.entries).toHaveLength(0);

    await optIn(T, subjects[0], '  Ada  ');
    const solo = await leaderboard(T, subjects[0], CHAL);
    expect(solo.belowFloor).toBe(true);
    expect(solo.entries).toHaveLength(1);
    expect(solo.entries[0].displayName).toBe('Ada'); // trimmed
    expect(solo.entries[0].you).toBe(true);

    await optIn(T, subjects[1], 'Bea');
    await optIn(T, subjects[2], 'Cal');
    // One completion for subject b — ranks first.
    await submitCheckIn(T, subjects[1], cardBySubject.get(subjects[1])!, {});
    const full = await leaderboard(T, subjects[0], CHAL);
    expect(full.belowFloor).toBe(false);
    expect(full.entries).toHaveLength(3);
    expect(full.entries[0].displayName).toBe('Bea');
    expect(full.entries[0].completedCount).toBe(1);
    expect(full.entries[0].rank).toBe(1);
    // Closed projection: nothing but the three fields + you.
    expect(Object.keys(full.entries[0]).sort()).toEqual(['completedCount', 'displayName', 'rank', 'you']);

    await optOut(T, subjects[2]);
    const after = await leaderboard(T, subjects[0], CHAL);
    expect(after.belowFloor).toBe(true); // back under the floor — immediate
    // Opted OUT but still enrolled: may look, is not ranked.
    const lookingOut = await leaderboard(T, subjects[2], CHAL);
    expect(lookingOut.entries.some((e) => e.you)).toBe(false);
    await optIn(T, subjects[2], 'Cal');
  });

  it('ADR 0641 d13 — enrolment gates LOOKING, the opt-in gates APPEARING', async () => {
    // The outsider is enrolled in OTHER_CHAL only. Not a member here ⇒ cannot look,
    // and the error is distinct from the opt-in one so the route can 404 rather
    // than leak whether this challenge has a board at all.
    await expect(leaderboard(T, OUTSIDER, CHAL)).rejects.toBeInstanceOf(NotEnrolledError);

    // ...and being opted IN to the tenant's leaderboard does not buy membership:
    // the two gates are independent, not a fallback for one another.
    await optIn(T, OUTSIDER, 'Zed');
    await expect(leaderboard(T, OUTSIDER, CHAL)).rejects.toBeInstanceOf(NotEnrolledError);
  });

  it('ADR 0641 d13 — boards are per-challenge and completions do not bleed across them', async () => {
    // subjects[1] has exactly ONE check-in, and it belongs to CHAL. The outsider
    // is opted in and enrolled in OTHER_CHAL with no check-ins.
    const other = await leaderboard(T, OUTSIDER, OTHER_CHAL);
    // Only the outsider is enrolled here, so CHAL's three members are absent —
    // the tenant-wide board would have listed them.
    expect(other.entries.every((e) => e.displayName !== 'Bea')).toBe(true);
    expect(other.belowFloor).toBe(true); // one member, well under k=3

    // The outsider's own total on THIS challenge is 0 even though the cached
    // per-subject stat row would have summed every enrollment they hold.
    const self = other.entries.find((e) => e.you);
    expect(self?.completedCount ?? 0).toBe(0);

    // And Bea's single completion still counts on CHAL, not on OTHER_CHAL.
    const home = await leaderboard(T, subjects[0], CHAL);
    expect(home.entries.find((e) => e.displayName === 'Bea')?.completedCount).toBe(1);
  });
});

describe('awards via the check-in observer (P2)', () => {
  it('first check-in awards once; duplicate submission never re-awards', async () => {
    const before = await listAwards(T, subjects[1]);
    expect(before.map((a) => a.kind)).toContain('first-check-in');
    expect(before.map((a) => a.kind)).toContain('challenge-complete'); // 1 required activity, completed

    // Idempotent: recorded evidence wins upstream — the observer never re-fires.
    await submitCheckIn(T, subjects[1], cardBySubject.get(subjects[1])!, {});
    const after = await listAwards(T, subjects[1]);
    expect(after).toHaveLength(before.length);
  });
});

describe('effectiveness (P3)', () => {
  it('returns counts-only buckets keyed by variant', async () => {
    const buckets = await effectivenessByVariant(T, async () => 'default');
    // FOUR, not three: `effectivenessByVariant` is deliberately TENANT-wide — it
    // answers an experiment question about the whole tenant, not about one
    // challenge — so the outsider opted in by the ADR 0641 d13 test above counts
    // here. Scoping this to a challenge would be a separate decision; d13 moved
    // the LEADERBOARD only.
    expect(buckets.default.members).toBe(4);
    expect(buckets.default.completed).toBe(1);
    expect(Object.keys(buckets.default).sort()).toEqual(['completed', 'members']);
  });
});
