/**
 * ADR 0465 — challenge review → content-kernel projection. Pins the projection
 * SYNC + the load-bearing PRIVACY invariant (reviewer anonymity):
 *  - a VISIBLE review projects a live `kicktodo.review` kernel entity carrying
 *    rating/body/provenance/challenge_id;
 *  - THE PRIVACY ASSERTION: the entity id is NOT the reviewerSubject and NO value
 *    equals/contains it (contrast the creator-profile projection, which keys by the
 *    subject on purpose — a profile subject is public, a review's reviewer is not);
 *  - flag / remove deletes the entity; erasing the subject deletes their entities.
 * The public-read GATE over the entity is covered elsewhere; here we assert the
 * record itself via `getSystemEntity` (toggle-independent).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import {
  putReview, flagReview, resolveReviewFlag, eraseCommunitySubject,
  reconcileReviewProjections, __test,
} from '../src/features/kicktodo-community/communityService.js';
import { REVIEW_TYPE } from '../src/features/kicktodo-community/reviewProjection.js';
import { getSystemEntity } from '../src/features/entities/entitiesService.js';

const T = 'tenant-rev-kernel';

let challengeId = '';

/** Enroll a buyer, complete the (single-action) challenge to earn proof, then
 *  write a review. Returns the persisted review (carrying its random entityId). */
async function reviewAs(buyer: string, input: { rating: number; body?: string }) {
  await enroll({ tenantId: T, ownerSubject: buyer, challengeId, challengeVersion: 1, timezone: 'UTC' });
  const today = await todayFor(T, buyer);
  await submitCheckIn(T, buyer, today.enrollments[0].actions[0].occurrence.cardId, {});
  return putReview(T, buyer, { challengeId, challengeVersion: 1, ...input });
}

const projection = (entityId: string) => getSystemEntity(T, REVIEW_TYPE, entityId);

beforeAll(async () => {
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __clearEnrollGuards();
  __clearCheckInObservers();
  const draft = await createDraft({
    tenantId: T, title: 'Reviewable', summary: 's', outcome: 'o', durationDays: 1,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Only action', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
});

describe('challenge review → kernel projection (ADR 0465)', () => {
  it('a visible review projects a live kernel entity carrying rating/body/provenance/challengeId', async () => {
    const buyer = 'user:rev-buyer-a';
    const review = await reviewAs(buyer, { rating: 5, body: 'Great challenge' });
    expect(review.reviewEntityId).toMatch(/^rev:/);

    const rec = await projection(review.reviewEntityId!);
    expect(rec).not.toBeNull();
    expect(rec?.status).not.toBe('draft'); // live ⇒ public-read-eligible
    expect(rec?.values.rating).toBe(5);
    expect(rec?.values.body).toBe('Great challenge');
    expect(rec?.values.provenance).toBe('completed-enrollment');
    expect(rec?.values.challenge_id).toBe(challengeId);
  });

  it('ADR 0465 PRIVACY — the entity id is NOT the reviewer subject and NO value leaks it (reviewer-anonymous)', async () => {
    const buyer = 'user:rev-buyer-secret';
    const review = await reviewAs(buyer, { rating: 4, body: 'Solid' });
    const rec = await projection(review.reviewEntityId!);
    expect(rec).not.toBeNull();

    // The kernel entity is keyed by the RANDOM per-review id — never the reviewer's
    // opaque subject (which would leak into the public URL: who-reviewed-what
    // enumeration + cross-challenge reviewer correlation — ADR 0426).
    expect(review.reviewEntityId).not.toBe(buyer);
    expect(rec!.entityId).not.toBe(buyer);
    expect(rec!.entityId).not.toContain(buyer);
    // The reviewer subject appears in NO projected value (id or body), only the
    // intended-public review content does.
    expect(JSON.stringify(rec!.values)).not.toContain(buyer);
    expect(Object.keys(rec!.values).sort()).toEqual(['body', 'challenge_id', 'provenance', 'rating']);
  });

  it('flag hides the review → the kernel entity is deleted; restore re-publishes it', async () => {
    const buyer = 'user:rev-buyer-flag';
    const flagger = 'user:rev-flagger';
    const review = await reviewAs(buyer, { rating: 2 });
    expect(await projection(review.reviewEntityId!)).not.toBeNull();

    await flagReview(T, flagger, challengeId, buyer, 'spam');
    expect(await projection(review.reviewEntityId!)).toBeNull(); // hidden ⇒ pulled down

    // Restore (reject the flag) → re-published.
    await resolveReviewFlag(T, challengeId, buyer, false);
    expect(await projection(review.reviewEntityId!)).not.toBeNull();
  });

  it('remove (approve the flag) → the kernel entity stays deleted', async () => {
    const buyer = 'user:rev-buyer-remove';
    const flagger = 'user:rev-flagger';
    const review = await reviewAs(buyer, { rating: 1 });
    await flagReview(T, flagger, challengeId, buyer, 'abuse');
    await resolveReviewFlag(T, challengeId, buyer, true); // remove
    expect(await projection(review.reviewEntityId!)).toBeNull();
  });

  it('erasing the subject deletes their review kernel entities', async () => {
    const buyer = 'user:rev-buyer-erase';
    const review = await reviewAs(buyer, { rating: 5, body: 'to be erased' });
    expect(await projection(review.reviewEntityId!)).not.toBeNull();

    await eraseCommunitySubject(T, buyer);
    expect(await projection(review.reviewEntityId!)).toBeNull(); // projection pulled down
    // The write-model row is gone too (the erasure completeness bar).
    expect(await __test.reviews.get(`${T}::${challengeId}::${buyer}`)).toBeNull();
  });

  it('ADR 0465 P3 — reconcile backfills a random id + re-derives a missing projection', async () => {
    const buyer = 'user:rev-buyer-legacy';
    const review = await reviewAs(buyer, { rating: 3 });

    // Simulate a legacy row written before P1: strip the entityId (and drop the
    // projection it published) to model a straggler with no kernel entity.
    const legacy = { ...review };
    delete legacy.reviewEntityId;
    await __test.reviews.put(legacy);
    // The old projection still exists under the original id; the reconcile mints a
    // NEW random id and publishes under it (idempotent, best-effort).
    const n = await reconcileReviewProjections(T);
    expect(n).toBeGreaterThanOrEqual(1);

    const healed = await __test.reviews.get(`${T}::${challengeId}::${buyer}`);
    expect(healed?.reviewEntityId).toMatch(/^rev:/);
    expect(healed?.reviewEntityId).not.toBe(buyer);
    expect(await projection(healed!.reviewEntityId!)).not.toBeNull();
  });
});
