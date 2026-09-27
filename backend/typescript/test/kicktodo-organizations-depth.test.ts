/**
 * ADR 0428 — the B2B pillar's second suite. The existing file proves the three
 * headline behaviours; this one pins the edges that were untested:
 *  - unlink is SYMMETRIC with link (owner only; a non-owner is refused with the
 *    same uniform not-found; an absent link is a no-op), and the link list
 *    reflects both;
 *  - removing a library entry restores the full catalog (an empty library is
 *    "no library", not "nothing allowed"), and re-adding is idempotent;
 *  - the k-floor is EXACT: k-1 active members withholds, k shows;
 *  - the brand ref round-trips and refuses an empty or oversized id;
 *  - nothing in the report ever names a member.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { createCircle, inviteToCircle } from '../src/features/kicktodo-accountability/circleService.js';
import { createCohortDetail, joinCohort } from '../src/features/kicktodo-accountability/cohortService.js';
import {
  setLibraryEntry, libraryCatalog, getLibrary, linkCohort, unlinkCohort, listCohortLinks, orgReport,
  setBrandRef, getBrandRef, OrgProgramError, OrgProgramNotFoundError, REPORT_K_FLOOR,
} from '../src/features/kicktodo-organizations/orgProgramService.js';

const T = 'tenant-orgprog-depth';
const ORG = 'org:depth-1';
const COACH = 'user:orgd-coach';
const OTHER_COACH = 'user:orgd-other';
let challengeId = '';
let atFloorCircle = '';
let belowFloorCircle = '';
let otherCoachCircle = '';

/** A cohort whose ACTIVE member count is exactly `active` (the owner's own grant counts). */
async function makeCohort(owner: string, name: string, active: number): Promise<string> {
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: owner, name });
  await createCohortDetail({ circle, actorSubject: owner, capacity: 50, startDateLocal: '2026-07-01' });
  for (let i = 0; i < active - 1; i += 1) {
    const subject = `user:orgd-${name}-${i}`;
    await inviteToCircle(T, circle.id, owner, subject, ['progress-summary']);
    await joinCohort(circle.id, subject);
  }
  return circle.id;
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
  const draft = await createDraft({
    tenantId: T, title: 'Org Depth', summary: 's', outcome: 'o', durationDays: 1,
    activities: [{ stableActivityId: 'x', day: 1, title: 't', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
  atFloorCircle = await makeCohort(COACH, 'atfloor', REPORT_K_FLOOR);
  belowFloorCircle = await makeCohort(COACH, 'below', REPORT_K_FLOOR - 1);
  otherCoachCircle = await makeCohort(OTHER_COACH, 'theirs', 2);
});

describe('cohort links are symmetric (ARCH-M6)', () => {
  it('owner links and unlinks; a different coach is refused with the uniform not-found; an absent link is a no-op', async () => {
    await linkCohort(T, ORG, COACH, atFloorCircle);
    await linkCohort(T, ORG, OTHER_COACH, otherCoachCircle);
    expect((await listCohortLinks(T, ORG)).map((l) => l.circleId).sort()).toEqual([atFloorCircle, otherCoachCircle].sort());
    // The other coach cannot undo COACH's decision, and vice versa.
    await expect(unlinkCohort(T, ORG, atFloorCircle, OTHER_COACH)).rejects.toBeInstanceOf(OrgProgramNotFoundError);
    await expect(unlinkCohort(T, ORG, otherCoachCircle, COACH)).rejects.toBeInstanceOf(OrgProgramNotFoundError);
    await unlinkCohort(T, ORG, otherCoachCircle, OTHER_COACH);
    expect((await listCohortLinks(T, ORG)).map((l) => l.circleId)).toEqual([atFloorCircle]);
    await expect(unlinkCohort(T, ORG, otherCoachCircle, OTHER_COACH)).resolves.toBeUndefined(); // already gone — no-op
    // The report only covers what is linked.
    expect((await orgReport(T, ORG)).map((c) => c.circleId)).toEqual([atFloorCircle]);
  });
});

describe('the k-floor is exact', () => {
  it(`k-1 active members withholds; exactly k shows buckets; no member is ever named`, async () => {
    await linkCohort(T, ORG, COACH, belowFloorCircle);
    const cells = await orgReport(T, ORG);
    const shown = cells.find((c) => c.circleId === atFloorCircle)!;
    const withheld = cells.find((c) => c.circleId === belowFloorCircle)!;
    expect(shown.outcome?.activeMembers).toBe(REPORT_K_FLOOR);
    expect(withheld.outcome).toBeNull();
    expect(withheld.withheldReason).toBe('below-k-floor');
    expect(JSON.stringify(cells)).not.toContain('user:orgd-');
  });
});

describe('library overlay edges', () => {
  it('removing the only entry restores the full catalog; re-adding is idempotent; the raw library records who added', async () => {
    const lib = await setLibraryEntry(T, ORG, 'user:orgd-admin', { challengeId, version: 1, present: true });
    expect(lib.entries).toHaveLength(1);
    expect(lib.entries[0]?.addedBy).toBe('user:orgd-admin');
    expect((await libraryCatalog(T, ORG)).curated).toBe(true);
    // Idempotent: the same entry again is still one entry.
    expect((await setLibraryEntry(T, ORG, 'user:orgd-admin', { challengeId, version: 1, present: true })).entries).toHaveLength(1);
    // Remove it: an EMPTY library is "no library" — the full catalog, not "nothing".
    expect((await setLibraryEntry(T, ORG, 'user:orgd-admin', { challengeId, version: 1, present: false })).entries).toHaveLength(0);
    const after = await libraryCatalog(T, ORG);
    expect(after.curated).toBe(false);
    expect(after.challenges.map((c) => c.id)).toContain(challengeId);
    expect((await getLibrary(T, ORG))?.entries).toEqual([]);
    // Removing an entry that was never present is a no-op, not an error.
    await expect(setLibraryEntry(T, ORG, 'user:orgd-admin', { challengeId, version: 1, present: false })).resolves.toBeTruthy();
  });
});

describe('brand ref', () => {
  it('round-trips a trimmed id and refuses empty or oversized ids', async () => {
    expect(await getBrandRef(T, ORG)).toBeNull();
    await setBrandRef(T, ORG, '  brand:kicktodo  ');
    expect(await getBrandRef(T, ORG)).toBe('brand:kicktodo');
    await expect(setBrandRef(T, ORG, '   ')).rejects.toBeInstanceOf(OrgProgramError);
    await expect(setBrandRef(T, ORG, 'x'.repeat(201))).rejects.toBeInstanceOf(OrgProgramError);
    expect(await getBrandRef(T, ORG)).toBe('brand:kicktodo'); // a refused write changes nothing
  });
});
