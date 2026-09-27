/**
 * ADR 0429 P1+P2 — plan flexibility.
 *
 * P1 substitution:
 *  - the publish gate REFUSES an alternative whose evidencePolicy diverges
 *    from its parent (the occurrence COPIES the policy, so divergence would
 *    let a participant silently lower their own evidence bar)
 *  - substitution keeps the occurrence KEY and cardId (card + later check-in
 *    stay bound to the same row); unknown alternatives are a uniform denial
 *  - substitution is idempotent and refuses a superseded occurrence
 *
 * P2 missed-window:
 *  - absent policy ⇒ `skip` (published versions keep their exact meaning)
 *  - `collapse-recovery` materializes ONE recovery occurrence with the
 *    STRICTEST absorbed evidence policy, idempotent across re-fires, and
 *    stands down past the collapse cap
 *  - `ask` notifies ONCE per missed window, then `acceptRecovery` materializes
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend, getNotificationEmitter } from '../src/notifications/emitter.js';
import type { NotificationRecord } from '../src/types.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import {
  createDraft, publishChallenge, ChallengeValidationError,
} from '../src/features/kicktodo-core/challengeService.js';
import {
  enroll, __clearEnrollGuards, substituteOccurrence, SubstitutionDeniedError,
  occurrenceByCard, materializeOccurrences, __test as coreStore,
} from '../src/features/kicktodo-core/enrollmentService.js';
import {
  todayFor, submitCheckIn, __clearCheckInObservers,
  applyMissedWindowPolicy, acceptRecovery,
} from '../src/features/kicktodo-core/todayService.js';
import { setEnrollmentSnooze } from '../src/features/kicktodo-core/progressService.js';
import { getCard } from '../src/host/kanbanService.js';
import type { MissedWindowPolicy } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-flex';

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  setNotificationBackend(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

async function publishWith(activities: unknown[], policy?: MissedWindowPolicy, days = 5) {
  const draft = await createDraft({
    tenantId: T, title: 'Flex', summary: 's', outcome: 'o', durationDays: days,
    activities: activities as never,
    ...(policy ? { missedWindowPolicy: policy } : {}),
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

const BASE_ACTIVITY = {
  stableActivityId: 'run', day: 1, title: 'Run 5k', instructions: 'Run', evidencePolicy: 'measurement' as const,
};

describe('publisher-declared substitution (P1)', () => {
  it('the publish gate refuses an alternative whose evidence policy diverges', async () => {
    await expect(publishWith([{
      ...BASE_ACTIVITY,
      alternatives: [{ stableActivityId: 'walk', title: 'Walk', instructions: 'Walk', evidencePolicy: 'attestation' }],
    }])).rejects.toBeInstanceOf(ChallengeValidationError);

    // …and refuses an alternative reusing its parent's id.
    await expect(publishWith([{
      ...BASE_ACTIVITY,
      alternatives: [{ ...BASE_ACTIVITY, title: 'Same id' }],
    }])).rejects.toBeInstanceOf(ChallengeValidationError);
  });

  it('substitution preserves the occurrence key + cardId, is idempotent, and denies unknown ids uniformly', async () => {
    const challengeId = await publishWith([{
      ...BASE_ACTIVITY,
      alternatives: [{ stableActivityId: 'row', title: 'Row 5k', instructions: 'Row instead', evidencePolicy: 'measurement' }],
    }]);
    const owner = 'user:flex-a';
    await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const today = await todayFor(T, owner);
    const cardId = today.enrollments[0]!.actions[0]!.occurrence.cardId;

    const before = await occurrenceByCard(T, cardId);
    const after = await substituteOccurrence(T, owner, cardId, 'row');
    expect(after.cardId).toBe(cardId);                                  // key unchanged
    expect(after.stableActivityId).toBe(before!.stableActivityId);      // parent id unchanged
    expect(after.substitutedActivityId).toBe('row');
    expect(after.evidencePolicy).toBe('measurement');                   // bar unchanged
    expect((await getCard(cardId))?.title).toContain('Row 5k');         // card retitled via the seam

    // Idempotent.
    expect((await substituteOccurrence(T, owner, cardId, 'row')).substitutedActivityId).toBe('row');

    // Unknown alternative, and a foreign owner, are both uniform denials.
    await expect(substituteOccurrence(T, owner, cardId, 'nope')).rejects.toBeInstanceOf(SubstitutionDeniedError);
    await expect(substituteOccurrence(T, 'user:flex-intruder', cardId, 'row')).rejects.toBeInstanceOf(SubstitutionDeniedError);

    // A substituted action still checks in against the SAME row.
    const ci = await submitCheckIn(T, owner, cardId, { measuredValue: 5 });
    expect(ci.cardId).toBe(cardId);
  });
});

describe('missed-window policy (P2)', () => {
  async function enrollStartedDaysAgo(challengeId: string, owner: string, daysAgo: number) {
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const row = await coreStore.enrollments.get(`${T}::${enrollment.id}`);
    await coreStore.enrollments.put({ ...row!, startDateLocal: isoDaysAgo(daysAgo) });
    // Materialize the missed day explicitly (the loop would have, on that day).
    await materializeOccurrences(T, enrollment.id, isoDaysAgo(daysAgo));
    return enrollment.id;
  }

  it('absent policy is `skip` — nothing is materialized for missed days', async () => {
    const challengeId = await publishWith([BASE_ACTIVITY]); // no policy
    const id = await enrollStartedDaysAgo(challengeId, 'user:flex-skip', 2);
    const r = await applyMissedWindowPolicy(T, id);
    expect(r.policy).toBe('skip');
    expect(r.recoveryCardId).toBeUndefined();
  });

  it('collapse-recovery materializes ONE recovery with the strictest policy, idempotently', async () => {
    const challengeId = await publishWith([
      { ...BASE_ACTIVITY, day: 1 },                                                            // measurement
      { stableActivityId: 'read', day: 2, title: 'Read', instructions: 'Read', evidencePolicy: 'attestation' },
    ], 'collapse-recovery');
    const id = await enrollStartedDaysAgo(challengeId, 'user:flex-collapse', 2);
    await materializeOccurrences(T, id, isoDaysAgo(1)); // day 2 also missed

    const first = await applyMissedWindowPolicy(T, id);
    expect(first.missed).toBeGreaterThanOrEqual(1);
    expect(first.recoveryCardId).toBeTruthy();
    const occ = await occurrenceByCard(T, first.recoveryCardId!);
    expect(occ!.stableActivityId.startsWith('recovery::')).toBe(true);
    expect(occ!.evidencePolicy).toBe('measurement'); // strictest absorbed — never lowered

    // Re-fire converges on the SAME recovery (deterministic key).
    const again = await applyMissedWindowPolicy(T, id);
    expect(again.recoveryCardId).toBe(first.recoveryCardId);
  });

  it('collapse stands down past the cap — a long absence is surfaced, not patched', async () => {
    const challengeId = await publishWith([
      { ...BASE_ACTIVITY, day: 1 }, { ...BASE_ACTIVITY, stableActivityId: 'a2', day: 2 },
      { ...BASE_ACTIVITY, stableActivityId: 'a3', day: 3 }, { ...BASE_ACTIVITY, stableActivityId: 'a4', day: 4 },
    ], 'collapse-recovery', 10);
    const id = await enrollStartedDaysAgo(challengeId, 'user:flex-cap', 4);
    for (const back of [3, 2, 1]) await materializeOccurrences(T, id, isoDaysAgo(back));
    const r = await applyMissedWindowPolicy(T, id);
    expect(r.missed).toBeGreaterThan(3);
    expect(r.recoveryCardId).toBeUndefined(); // past COLLAPSE_CAP_DAYS
    const preview = (await todayFor(T, 'user:flex-cap')).enrollments.find((e) => e.enrollmentId === id)?.recovery;
    expect(preview).toEqual({ missed: 4, mode: 'review' });
  });

  it('ADR 0456 — a stall past the cap emits the consent-gated `stalled` lifecycle event', async () => {
    const { createContact } = await import('../src/features/crm/contactsService.js');
    const { linkSubjectToContact } = await import('../src/features/kicktodo-core/contactBridgeService.js');
    const { listCollectedEvents } = await import('../src/features/cdp/collectService.js');
    const challengeId = await publishWith([
      { ...BASE_ACTIVITY, day: 1 }, { ...BASE_ACTIVITY, stableActivityId: 'a2', day: 2 },
      { ...BASE_ACTIVITY, stableActivityId: 'a3', day: 3 }, { ...BASE_ACTIVITY, stableActivityId: 'a4', day: 4 },
    ], 'collapse-recovery', 10);
    const SUBJ = 'user:flex-stall';
    const contact = await createContact({ tenantId: T, name: 'S', email: 's@x.test' });
    await linkSubjectToContact(T, SUBJ, contact.contactId, 'reminder-consent'); // consent ⇒ marketing signal allowed
    const id = await enrollStartedDaysAgo(challengeId, SUBJ, 4);
    for (const back of [3, 2, 1]) await materializeOccurrences(T, id, isoDaysAgo(back));
    const r = await applyMissedWindowPolicy(T, id);
    expect(r.missed).toBeGreaterThan(3);
    expect((await listCollectedEvents(T)).map((e) => e.eventType)).toContain('kicktodo.participant.stalled');
  });

  it('ask notifies ONCE per missed window; acceptRecovery then materializes', async () => {
    const captured: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if ((n.metadata as Record<string, unknown> | undefined)?.category === 'kicktodo-recovery') captured.push(n);
    });
    try {
      const challengeId = await publishWith([BASE_ACTIVITY], 'ask');
      const owner = 'user:flex-ask';
      const id = await enrollStartedDaysAgo(challengeId, owner, 2);

      const first = await applyMissedWindowPolicy(T, id);
      expect(first.asked).toBe(true);
      expect(captured).toHaveLength(1);
      expect(first.recoveryCardId).toBeUndefined(); // asks, does not act

      const preview = (await todayFor(T, owner)).enrollments.find((e) => e.enrollmentId === id)?.recovery;
      expect(preview).toEqual({ missed: 1, mode: 'offer' });

      // Re-fired loop must NOT re-ask.
      const second = await applyMissedWindowPolicy(T, id);
      expect(second.asked).toBe(false);
      expect(captured).toHaveLength(1);

      const occ = await acceptRecovery(T, owner, id);
      expect(occ!.stableActivityId.startsWith('recovery::')).toBe(true);
      const accepted = (await todayFor(T, owner)).enrollments.find((e) => e.enrollmentId === id);
      expect(accepted?.recovery).toBeUndefined();
      expect(accepted?.actions.some((action) => action.occurrence.cardId === occ!.cardId)).toBe(true);
      // Idempotent on repeat.
      expect((await acceptRecovery(T, owner, id))!.cardId).toBe(occ!.cardId);
    } finally {
      unsub();
    }
  });

  it('keeps a snoozed enrollment visible with no actions so Resume remains reachable', async () => {
    const challengeId = await publishWith([BASE_ACTIVITY]);
    const owner = 'user:flex-snooze';
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });

    await setEnrollmentSnooze(T, enrollment.id, owner, true);
    const row = (await todayFor(T, owner)).enrollments.find((item) => item.enrollmentId === enrollment.id);

    expect(row?.state).toBe('snoozed');
    expect(row?.actions).toEqual([]);
  });
});
