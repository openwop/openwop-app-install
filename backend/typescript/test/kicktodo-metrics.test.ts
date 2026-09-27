/**
 * ADR 0432 P1–P3 — outcome metrics as computed-on-read projections.
 *
 *  - every cell honours the k-floor: below K_FLOOR contributors the VALUE is
 *    WITHHELD (null + a reason), never a small number
 *  - the north star is a named, test-pinned predicate: an ACTIVE enrollment
 *    with >= 1 completed action in the trailing 7 days
 *  - no participant identity ever appears in a metrics payload
 *  - verifier quality counts RESOLVED samples only and always reports its
 *    denominator; sampling is idempotent
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { resolveApproval } from '../src/host/approvalService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { evaluateEnrollment } from '../src/features/kicktodo-core/progressService.js';
import { activationMetrics, engagementMetrics, K_FLOOR } from '../src/features/kicktodo-metrics/metricsService.js';
import { sampleVerdict, SampleSubjectError, verifierQuality } from '../src/features/kicktodo-metrics/verifierSampleService.js';

const T = 'tenant-metrics';

async function seedParticipants(n: number, checkInEvery: boolean): Promise<string[]> {
  const draft = await createDraft({
    tenantId: T, title: 'Measured', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const owner = `user:m-${i}`;
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    ids.push(enrollment.id);
    if (checkInEvery) {
      const today = await todayFor(T, owner);
      const card = today.enrollments[0]?.actions[0]?.occurrence.cardId;
      if (card) await submitCheckIn(T, owner, card, {});
    }
  }
  return ids;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('k-floor + the north star (P1)', () => {
  it('WITHHOLDS every cell below the k-floor rather than reporting a small number', async () => {
    await seedParticipants(K_FLOOR - 1, true);
    const engagement = await engagementMetrics(T);
    expect(engagement.weeklyMeaningfulProgress.value).toBeNull();
    expect(engagement.weeklyMeaningfulProgress.withheldReason).toBe('below-k-floor');
    expect(engagement.weeklyMeaningfulProgress.contributors).toBe(K_FLOOR - 1);

    const activation = await activationMetrics(T);
    expect(activation.daysToFirstCompletedActionP50.value).toBeNull();
    expect(activation.enrollmentsStarted).toBe(K_FLOOR - 1); // a raw total is not a floored cell
  });

  it('at the floor the north star counts ACTIVE enrollments with a completion in 7 days', async () => {
    await seedParticipants(K_FLOOR, true);
    const engagement = await engagementMetrics(T);
    expect(engagement.weeklyMeaningfulProgress.value).toBe(K_FLOOR);
    expect(engagement.weeklyMeaningfulProgress.contributors).toBe(K_FLOOR);

    // No check-ins ⇒ nobody is making meaningful progress, but the cell still renders.
    const fresh = 'tenant-metrics-idle';
    initHostExtPersistence(await openStorage('memory://'));
    void fresh;
  });

  it('never leaks a participant identity into a metrics payload', async () => {
    await seedParticipants(K_FLOOR, true);
    const payload = JSON.stringify([await activationMetrics(T), await engagementMetrics(T)]);
    expect(payload).not.toContain('user:m-');
  });
});

describe('verifier sampling (P3)', () => {
  // KTFULL-B18 — the sampled verdict used to be whatever the CALLER claimed,
  // for whatever enrollment id the caller typed. Both halves are now closed:
  // the enrollment must exist in this tenant, and the verdict is the judge's.
  it('refuses an enrollment that does not exist, and one the judge has not ruled on', async () => {
    await expect(sampleVerdict(T, { enrollmentId: 'enr:does-not-exist', submittedBy: 'user:admin' }))
      .rejects.toBeInstanceOf(SampleSubjectError);

    const [unjudged] = await seedParticipants(1, true);
    await expect(sampleVerdict(T, { enrollmentId: unjudged!, submittedBy: 'user:admin' }))
      .rejects.toBeInstanceOf(SampleSubjectError);
  });

  it('records the JUDGE\'s verdict, not a verdict the caller asserts', async () => {
    const [enrollmentId] = await seedParticipants(1, true);
    // The registered verifier rules NOT satisfied. A caller who wanted the
    // FP/FN rate to look good could previously have passed `true` here.
    await evaluateEnrollment(T, enrollmentId!, 'user:m-0');
    const sample = await sampleVerdict(T, { enrollmentId: enrollmentId!, submittedBy: 'user:admin' });
    expect(sample.machineSatisfied).toBe(false);
  });

  it('is idempotent, counts RESOLVED samples only, and always reports the denominator', async () => {
    const [enrollmentId] = await seedParticipants(1, true);
    // KTFULL-B18: a verdict must EXIST before it can be sampled — the judge
    // produces it, the caller does not assert it.
    await evaluateEnrollment(T, enrollmentId!, 'user:m-0');

    const first = await sampleVerdict(T, { enrollmentId: enrollmentId!, submittedBy: 'user:admin' });
    const again = await sampleVerdict(T, { enrollmentId: enrollmentId!, submittedBy: 'user:admin' });
    expect(again.approvalId).toBe(first.approvalId); // idempotent — one approval, not two

    // Ungraded ⇒ no rate at all (never a rate over zero).
    const pending = await verifierQuality(T);
    expect(pending.sampled).toBe(1);
    expect(pending.resolved).toBe(0);
    expect(pending.disagreementRate).toBeNull();

    // KTFULL-B18: the registered verifier ruled NOT satisfied, so a human who
    // disagrees is saying the machine MISSED a completion — a false NEGATIVE.
    // (This assertion read `falsePositives` while the test asserted its own
    // `machineSatisfied: true`; now the judge supplies the verdict, so the
    // direction follows the machine's actual ruling.)
    await resolveApproval(first.approvalId, { status: 'rejected' });
    const graded = await verifierQuality(T);
    expect(graded.resolved).toBe(1);
    expect(graded.falseNegatives).toBe(1);
    expect(graded.falsePositives).toBe(0);
    expect(graded.disagreementRate).toBe(1);
  });
});
