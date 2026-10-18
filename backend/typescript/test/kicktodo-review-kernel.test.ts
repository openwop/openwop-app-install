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
 *
 * Witnesses (w41): adding the reviewer subject to the projected values, or deriving
 * the entity id from it, reds the PRIVACY case; dropping the erase-side delete reds
 * the erasure case.
 */
import { resolveApproval } from '../src/host/approvalService.js';
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
import { interleavedStorage } from './helpers/interleavedStorage.js';

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

    const rec = await projection(review.reviewEntityId ?? '');
    expect(rec).not.toBeNull();
    // LIVE is stored as an ABSENT status (EntityRecord.status is only ever 'draft').
    expect(rec?.status).toBeUndefined(); // live ⇒ public-read-eligible
    expect(rec?.values.rating).toBe(5);
    expect(rec?.values.body).toBe('Great challenge');
    expect(rec?.values.provenance).toBe('completed-enrollment');
    expect(rec?.values.challenge_id).toBe(challengeId);
  });

  it('ADR 0465 PRIVACY — the entity id is NOT the reviewer subject and NO value leaks it (reviewer-anonymous)', async () => {
    const buyer = 'user:rev-buyer-secret';
    const review = await reviewAs(buyer, { rating: 4, body: 'Solid' });
    const rec = await projection(review.reviewEntityId ?? '');
    expect(rec).not.toBeNull();

    // The kernel entity is keyed by the RANDOM per-review id — never the reviewer's
    // opaque subject (which would leak into the public URL: who-reviewed-what
    // enumeration + cross-challenge reviewer correlation — ADR 0426).
    expect(review.reviewEntityId).not.toBe(buyer);
    expect(rec?.entityId).toBe(review.reviewEntityId);
    expect(rec?.entityId).not.toContain(buyer);
    // The reviewer subject appears in NO projected value (id or body), only the
    // intended-public review content does.
    expect(JSON.stringify(rec?.values)).not.toContain(buyer);
    expect(Object.keys(rec?.values ?? {}).sort()).toEqual(['body', 'challenge_id', 'provenance', 'rating']);
  });

  it('flag hides the review → the kernel entity is deleted; restore re-publishes it', async () => {
    const buyer = 'user:rev-buyer-flag';
    const flagger = 'user:rev-flagger';
    const review = await reviewAs(buyer, { rating: 2 });
    expect(await projection(review.reviewEntityId ?? '')).not.toBeNull();

    const flagged = await flagReview(T, flagger, challengeId, buyer, 'spam');
    expect(await projection(review.reviewEntityId ?? '')).toBeNull(); // hidden ⇒ pulled down

    // Restore (reject the flag) → re-published. The approval holds the decision.
    await resolveApproval(flagged.flagApprovalId ?? '', { status: 'rejected' });
    await resolveReviewFlag(T, challengeId, buyer, false, 'user:rev-moderator');
    expect(await projection(review.reviewEntityId ?? '')).not.toBeNull();
  });

  it('remove (approve the flag) → the kernel entity stays deleted', async () => {
    const buyer = 'user:rev-buyer-remove';
    const flagger = 'user:rev-flagger';
    const review = await reviewAs(buyer, { rating: 1 });
    const flagged = await flagReview(T, flagger, challengeId, buyer, 'abuse');
    await resolveApproval(flagged.flagApprovalId ?? '', { status: 'approved' });
    await resolveReviewFlag(T, challengeId, buyer, true, 'user:rev-moderator'); // remove
    expect(await projection(review.reviewEntityId ?? '')).toBeNull();
  });

  it('erasing the subject deletes their review kernel entities', async () => {
    const buyer = 'user:rev-buyer-erase';
    const review = await reviewAs(buyer, { rating: 5, body: 'to be erased' });
    expect(await projection(review.reviewEntityId ?? '')).not.toBeNull();

    await eraseCommunitySubject(T, buyer);
    expect(await projection(review.reviewEntityId ?? '')).toBeNull(); // projection pulled down
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
    expect(n).toBe(1); // fresh storage per case ⇒ exactly this one review

    const healed = await __test.reviews.get(`${T}::${challengeId}::${buyer}`);
    expect(healed?.reviewEntityId).toMatch(/^rev:/);
    expect(healed?.reviewEntityId).not.toBe(review.reviewEntityId); // a NEW random id was minted
    expect(healed?.reviewEntityId).not.toContain(buyer);
    expect(await projection(healed?.reviewEntityId ?? '')).not.toBeNull();
  });

  // KTCOM-Y2 — two reconcile runs over the same legacy row. The second runs to
  // completion between the first's list and its write (deterministic interleave).
  // Sabotage (witnessed): restore the blind `reviews.put(row)` backfill and the first
  // run overwrites the second's id, orphaning the entity the second published.
  it('concurrent reconciles mint ONE entity id for a legacy row (no orphaned kernel entity)', async () => {
    const race = interleavedStorage(await openStorage('memory://'));
    initHostExtPersistence(race.storage);
    const draft = await createDraft({
      tenantId: T, title: 'Reviewable', summary: 's', outcome: 'o', durationDays: 1,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'Only action', instructions: 'i', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(T, draft.id, 1);
    challengeId = draft.id;
    const buyer = 'user:rev-buyer-race';
    const review = await reviewAs(buyer, { rating: 4 });
    const legacy = { ...review };
    delete legacy.reviewEntityId;
    await __test.reviews.put(legacy);

    let competitorId: string | undefined;
    // KTY-5 (KickTodo wave 4C) — the tenant-scoped reconcile lists the TENANT's slice,
    // so the race is armed on that read (it was the whole-namespace scan before).
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-challenge-reviews:${T}::`, async () => {
      await reconcileReviewProjections(T);
      competitorId = (await __test.reviews.get(`${T}::${challengeId}::${buyer}`))?.reviewEntityId;
    });
    await reconcileReviewProjections(T);
    expect(race.fired()).toBe(true);

    expect(competitorId).toMatch(/^rev:/);
    const stored = await __test.reviews.get(`${T}::${challengeId}::${buyer}`);
    expect(stored?.reviewEntityId, 'the later run adopts the id the first mint published').toBe(competitorId);
    expect(await projection(competitorId ?? '')).not.toBeNull();
  });

  // KTCOM-Y2 — the other review writers (an edit, a flag) racing a reconcile mint on
  // a legacy row must keep the minted id, not write their stale id-less copy over it.
  // Sabotage (witnessed): restore `putReview`'s / `flagReview`'s blind `reviews.put`
  // and the edit mints a second id (orphan) / the flag drops the id entirely.
  it.each(['edit', 'flag'] as const)('a %s racing a reconcile keeps the id the reconcile minted', async (writer) => {
    const race = interleavedStorage(await openStorage('memory://'));
    initHostExtPersistence(race.storage);
    const draft = await createDraft({
      tenantId: T, title: 'Reviewable', summary: 's', outcome: 'o', durationDays: 1,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'Only action', instructions: 'i', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(T, draft.id, 1);
    challengeId = draft.id;
    const buyer = `user:rev-buyer-${writer}`;
    const review = await reviewAs(buyer, { rating: 4 });
    const legacy = { ...review };
    delete legacy.reviewEntityId;
    await __test.reviews.put(legacy);
    const key = `${T}::${challengeId}::${buyer}`;

    let mintedId: string | undefined;
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-challenge-reviews:${key}`, async () => {
      await reconcileReviewProjections(T);
      mintedId = (await __test.reviews.get(key))?.reviewEntityId;
    });
    if (writer === 'edit') await putReview(T, buyer, { challengeId, challengeVersion: 1, rating: 2 });
    else await flagReview(T, 'user:rev-flagger', challengeId, buyer, 'spam');
    expect(race.fired()).toBe(true);

    expect(mintedId).toMatch(/^rev:/);
    const stored = await __test.reviews.get(key);
    expect(stored?.reviewEntityId).toBe(mintedId);
    expect(stored?.state).toBe(writer === 'edit' ? 'visible' : 'flagged');
    if (writer === 'edit') expect(stored?.rating).toBe(2);
  });
});
