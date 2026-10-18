/**
 * ADR 0426 P1–P3 — community:
 *  - handle claims are atomic (second claimant rejected); profiles are public
 *    ONLY after approval by a DIFFERENT identity (separation of duties)
 *  - reviews require proof (completed enrollment here); ONE per buyer
 *    (deterministic key — an edit overwrites, never duplicates); flagged
 *    reviews hide immediately; the aggregate obeys the k=3 floor
 *  - creator analytics are counts-only
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { resolveApproval } from '../src/host/approvalService.js';
import {
  upsertProfile, submitProfile, applyProfileDecision, publicProfileByHandle,
  putReview, visibleReviews, aggregateRating, flagReview, resolveReviewFlag,
  HandleTakenError, ReviewProofError, SeparationOfDutiesError,
} from '../src/features/kicktodo-community/communityService.js';

const T = 'tenant-community';
const CREATOR = 'user:comm-creator';
const BUYER = 'user:comm-buyer';
const MOD = 'user:comm-mod';

let challengeId = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
  const draft = await createDraft({
    tenantId: T, title: 'Reviewable', summary: 's', outcome: 'o', durationDays: 1,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Only action', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
});

describe('creator profiles (P1)', () => {
  it('atomic handle claim; separation of duties; approved-only public projection', async () => {
    await upsertProfile(T, CREATOR, { handle: 'Ada-Codes', displayName: 'Ada', bio: 'b', links: ['https://example.com'] });
    // Second claimant on the same handle (case-insensitive) → rejected.
    await expect(upsertProfile(T, MOD, { handle: 'ada-codes', displayName: 'X' })).rejects.toBeInstanceOf(HandleTakenError);

    // Not public before approval.
    expect(await publicProfileByHandle(T, 'ada-codes')).toBeNull();
    const pending = await submitProfile(T, CREATOR);

    // The OWNER cannot decide their own approval.
    await expect(applyProfileDecision(T, CREATOR, CREATOR, true)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    // COM-1: while the approval is still PENDING, nobody can apply an outcome —
    // the approval lane is the decision authority, this endpoint only applies it.
    await expect(applyProfileDecision(T, CREATOR, MOD, true)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    if (!pending.approvalId) throw new Error('submitting raises a community-profile approval');
    await resolveApproval(pending.approvalId, { status: 'approved' });
    // KT-R1: now the approval IS approved, so COM-1 no longer refuses — only the
    // owner check can stop the owner applying their own approval. (The PENDING
    // attempt above is refused by COM-1 first, which masked this check — round-1
    // probe w41g2-cm-sod-owner was vacuous.)
    await expect(applyProfileDecision(T, CREATOR, CREATOR, true)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    expect(await publicProfileByHandle(T, 'ada-codes')).toBeNull(); // still not public
    await applyProfileDecision(T, CREATOR, MOD, true);

    const pub = await publicProfileByHandle(T, 'ADA-CODES');
    expect(pub?.displayName).toBe('Ada');
    // Closed public projection.
    expect(Object.keys(pub ?? {}).sort()).toEqual(['bio', 'displayName', 'handle', 'links']);
  });

  // KTCOM-Y1 — a handle change releases the old index row only AFTER the profile
  // write (KTD-2 fails closed), so a failed release leaves `old → subject` behind.
  // The seeded row below is exactly that residue. Sabotage (witnessed): drop the
  // `p.handle !== handleLower` check and the released handle serves the profile.
  it('a released handle whose index row survived does not serve the profile', async () => {
    const GRACE = 'user:comm-grace';
    const approve = async (): Promise<void> => {
      const pending = await submitProfile(T, GRACE);
      if (!pending.approvalId) throw new Error('submitting raises a community-profile approval');
      await resolveApproval(pending.approvalId, { status: 'approved' });
      await applyProfileDecision(T, GRACE, MOD, true);
    };
    await upsertProfile(T, GRACE, { handle: 'grace-old', displayName: 'Grace' });
    await approve();
    expect((await publicProfileByHandle(T, 'grace-old'))?.handle).toBe('grace-old'); // control

    await upsertProfile(T, GRACE, { handle: 'grace-new', displayName: 'Grace' });
    const handleIndex = new DurableCollection<{ tenantId: string; handleLower: string; creatorSubject: string }>(
      'kicktodo-handle-index', (h) => `${h.tenantId}::${h.handleLower}`);
    await handleIndex.put({ tenantId: T, handleLower: 'grace-old', creatorSubject: GRACE }); // the failed release
    await approve();

    expect((await publicProfileByHandle(T, 'grace-new'))?.handle).toBe('grace-new');
    expect(await publicProfileByHandle(T, 'grace-old'), 'the released handle must not serve the moved profile').toBeNull();
  });
});

describe('proof-gated reviews (P2)', () => {
  it('no proof → denied; completion grants proof; one per buyer; flag hides; k-floor', async () => {
    await expect(putReview(T, BUYER, { challengeId, challengeVersion: 1, rating: 5 })).rejects.toBeInstanceOf(ReviewProofError);

    // Complete the (single-action) challenge → proof.
    await enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const today = await todayFor(T, BUYER);
    const card = today.enrollments[0]?.actions[0]?.occurrence.cardId;
    if (!card) throw new Error('the single action must be due today');
    await submitCheckIn(T, BUYER, card, {});

    const first = await putReview(T, BUYER, { challengeId, challengeVersion: 1, rating: 5, body: 'Great' });
    expect(first.provenance).toBe('completed-enrollment');

    // Edit overwrites — never a second row.
    await putReview(T, BUYER, { challengeId, challengeVersion: 1, rating: 4, body: 'Still great' });
    const vis = await visibleReviews(T, challengeId);
    expect(vis).toHaveLength(1);
    expect(vis[0]?.rating).toBe(4);
    expect(vis[0]?.provenance).toBe('verified participant');
    // No reviewer PII in the projection.
    expect(JSON.stringify(vis)).not.toContain(BUYER);

    // Below the k=3 floor the aggregate withholds the average.
    expect((await aggregateRating(T, challengeId)).average).toBeNull();

    // Flag → hidden immediately; restore → visible again.
    const flagged = await flagReview(T, MOD, challengeId, BUYER, 'test flag');
    expect(await visibleReviews(T, challengeId)).toHaveLength(0);
    // Code-grade KTY-2 — the review's author cannot moderate it, and the route only
    // APPLIES a decision the approval already holds (COM-1, as for profiles).
    await expect(resolveReviewFlag(T, challengeId, BUYER, false, BUYER)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    await expect(resolveReviewFlag(T, challengeId, BUYER, false, CREATOR)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    if (!flagged.flagApprovalId) throw new Error('flagging raises a community-review approval');
    await resolveApproval(flagged.flagApprovalId, { status: 'rejected' });
    await expect(resolveReviewFlag(T, challengeId, BUYER, true, CREATOR)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    await resolveReviewFlag(T, challengeId, BUYER, false, CREATOR);
    expect(await visibleReviews(T, challengeId)).toHaveLength(1);
  });
});
