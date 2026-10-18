/**
 * ADR 0425 P1–P3 — engagement:
 *  - leaderboard requires opt-in; below k=3 the caller sees only themself;
 *    at k the closed projection ranks by completions; opt-out is immediate
 *  - awards derive idempotently via the check-in observer (deterministic ids —
 *    a duplicate check-in submission never re-awards)
 *  - effectiveness read returns counts-only buckets by variant
 *
 * Isolation (grade-tests w41): every case builds its OWN tenant ("world"), so no
 * case reads another's opt-ins, check-ins or awards and the file passes under shuffle.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, registerCheckInObserver, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import {
  optIn, optOut, leaderboard, listAwards, onCheckIn, evaluateAwards, effectivenessByVariant, NotEnrolledError,
} from '../src/features/kicktodo-engagement/engagementService.js';

const subjects = ['user:eng-a', 'user:eng-b', 'user:eng-c'] as const;
const OUTSIDER = 'user:eng-outsider';

interface World { T: string; CHAL: string; OTHER_CHAL: string; cardOf(subject: string): string }

/** A tenant of the case's own: CHAL with the three subjects enrolled, plus a SECOND
 *  challenge in the same tenant (OTHER_CHAL) with only the OUTSIDER enrolled. Before
 *  ADR 0641 decision 13 the two challenges' participants shared one board. */
async function world(tag: string): Promise<World> {
  const T = `tenant-engagement-${tag}`;
  const draft = await createDraft({
    tenantId: T, title: 'Engage', summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'act', day: 1, title: 'Do the thing', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const cards = new Map<string, string>();
  for (const s of subjects) {
    await enroll({ tenantId: T, ownerSubject: s, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    const card = (await todayFor(T, s)).enrollments[0]?.actions[0]?.occurrence.cardId;
    if (!card) throw new Error(`${s} must have today's action`);
    cards.set(s, card);
  }
  const other = await createDraft({
    tenantId: T, title: 'Other', summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'act2', day: 1, title: 'Other thing', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, other.id, 1);
  await enroll({ tenantId: T, ownerSubject: OUTSIDER, challengeId: other.id, challengeVersion: 1, timezone: 'UTC' });
  return {
    T, CHAL: draft.id, OTHER_CHAL: other.id,
    cardOf(subject) { const c = cards.get(subject); if (!c) throw new Error(`no card for ${subject}`); return c; },
  };
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
  registerCheckInObserver(onCheckIn);
});

describe('opt-in leaderboard (P1)', () => {
  it('k-floor hides others; ranks by completions; opt-out immediate', async () => {
    const { T, CHAL, cardOf } = await world('kfloor');
    // ADR 0641 decision 13 — an ENROLLED caller may LOOK before opting in. They
    // simply are not on the board yet: no rows, so the k-floor holds and the
    // self-only fallback finds nothing of theirs to show.
    const beforeOptIn = await leaderboard(T, subjects[0], CHAL);
    expect(beforeOptIn.belowFloor).toBe(true);
    expect(beforeOptIn.entries).toHaveLength(0);

    await optIn(T, subjects[0], '  Ada  ');
    const solo = await leaderboard(T, subjects[0], CHAL);
    expect(solo.belowFloor).toBe(true);
    expect(solo.entries).toEqual([{ displayName: 'Ada', completedCount: 0, rank: 1, you: true }]); // trimmed

    await optIn(T, subjects[1], 'Bea');
    await optIn(T, subjects[2], 'Cal');
    // One completion for subject b — ranks first.
    await submitCheckIn(T, subjects[1], cardOf(subjects[1]), {});
    const full = await leaderboard(T, subjects[0], CHAL);
    expect(full.belowFloor).toBe(false);
    expect(full.entries).toHaveLength(3);
    expect(full.entries[0]).toEqual({ displayName: 'Bea', completedCount: 1, rank: 1, you: false });
    // Closed projection: nothing but the three fields + you.
    expect(Object.keys(full.entries[0] ?? {}).sort()).toEqual(['completedCount', 'displayName', 'rank', 'you']);

    await optOut(T, subjects[2]);
    const after = await leaderboard(T, subjects[0], CHAL);
    expect(after.belowFloor).toBe(true); // back under the floor — immediate
    // Below the floor the caller sees ONLY themself — Bea is still opted in, and
    // hidden (this is the "k-floor hides others" half).
    expect(after.entries).toEqual([{ displayName: 'Ada', completedCount: 0, rank: 1, you: true }]);
    // Opted OUT but still enrolled: may look, is not ranked.
    const lookingOut = await leaderboard(T, subjects[2], CHAL);
    expect(lookingOut.entries).toEqual([]);
  });

  it('ADR 0641 d13 — enrolment gates LOOKING, the opt-in gates APPEARING', async () => {
    const { T, CHAL, OTHER_CHAL } = await world('look');
    // The outsider is enrolled in OTHER_CHAL only. Not a member here ⇒ cannot look,
    // and the error is distinct from the opt-in one so the route can 404 rather
    // than leak whether this challenge has a board at all.
    await expect(leaderboard(T, OUTSIDER, CHAL)).rejects.toBeInstanceOf(NotEnrolledError);

    // ...and being opted IN to the tenant's leaderboard does not buy membership:
    // the two gates are independent, not a fallback for one another.
    await optIn(T, OUTSIDER, 'Zed');
    await expect(leaderboard(T, OUTSIDER, CHAL)).rejects.toBeInstanceOf(NotEnrolledError);
    // Positive control: on the challenge they ARE enrolled in, they may look (and appear).
    expect((await leaderboard(T, OUTSIDER, OTHER_CHAL)).entries).toEqual([{ displayName: 'Zed', completedCount: 0, rank: 1, you: true }]);
  });

  it('ADR 0641 d13 — boards are per-challenge and completions do not bleed across them', async () => {
    const { T, CHAL, OTHER_CHAL, cardOf } = await world('scope');
    await optIn(T, subjects[0], 'Ada');
    await optIn(T, subjects[1], 'Bea');
    await optIn(T, OUTSIDER, 'Zed');
    // subjects[1] has exactly ONE check-in, and it belongs to CHAL.
    await submitCheckIn(T, subjects[1], cardOf(subjects[1]), {});

    const other = await leaderboard(T, OUTSIDER, OTHER_CHAL);
    // Only the outsider is enrolled here, so CHAL's members are absent —
    // the tenant-wide board would have listed them.
    expect(other.entries.every((e) => e.displayName !== 'Bea')).toBe(true);
    expect(other.belowFloor).toBe(true); // one member, well under k=3
    // The outsider's own total on THIS challenge is 0.
    expect(other.entries).toEqual([{ displayName: 'Zed', completedCount: 0, rank: 1, you: true }]);

    // And Bea's single completion still counts on CHAL, not on OTHER_CHAL.
    const home = await leaderboard(T, subjects[1], CHAL);
    expect(home.entries.find((e) => e.you)).toEqual({ displayName: 'Bea', completedCount: 1, rank: 1, you: true });
  });
});

describe('awards via the check-in observer (P2)', () => {
  it('first check-in awards once; duplicate submission never re-awards', async () => {
    const { T, cardOf } = await world('awards');
    const ci = await submitCheckIn(T, subjects[1], cardOf(subjects[1]), {});
    const before = await listAwards(T, subjects[1]);
    expect(before.map((a) => a.kind).sort()).toEqual(['challenge-complete', 'first-check-in']); // 1 required activity, completed

    // A duplicate SUBMISSION returns the recorded check-in upstream, so the
    // observer never re-fires…
    await submitCheckIn(T, subjects[1], cardOf(subjects[1]), {});
    expect(await listAwards(T, subjects[1])).toHaveLength(before.length);
    // …and a direct RE-EVALUATION of the same check-in (a replay / re-delivered
    // observer) earns nothing new: deterministic award ids make it a no-op, so no
    // second celebration is announced.
    expect(await evaluateAwards(ci)).toEqual([]);
    expect(await listAwards(T, subjects[1])).toHaveLength(before.length);
  });
});

describe('effectiveness (P3)', () => {
  it('returns counts-only buckets keyed by variant', async () => {
    const { T, cardOf } = await world('effect');
    await optIn(T, subjects[0], 'Ada');
    await optIn(T, subjects[1], 'Bea');
    await optIn(T, subjects[2], 'Cal');
    await optOut(T, subjects[2]); // a revoked opt-in is not a member
    await submitCheckIn(T, subjects[1], cardOf(subjects[1]), {});
    const buckets = await effectivenessByVariant(T, async () => 'default');
    expect(buckets).toEqual({ default: { members: 2, completed: 1 } });
  });
});
