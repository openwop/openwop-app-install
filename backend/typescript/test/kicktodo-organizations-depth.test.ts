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
  setBrandRef, getBrandRef, OrgProgramError, OrgProgramNotFoundError, REPORT_K_FLOOR, __test as orgStores,
} from '../src/features/kicktodo-organizations/orgProgramService.js';

const T = 'tenant-orgprog-depth';
// One org per describe: each case owns its links/library/brand, so the file passes
// in any order (`--sequence.shuffle`).
const ORG_SYM = 'org:depth-sym';
const ORG_K = 'org:depth-k';
const ORG_LIB = 'org:depth-lib';
const ORG_LIB_EMPTYING = 'org:depth-lib-emptying';
const ORG_BRAND = 'org:depth-brand';
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
    await linkCohort(T, ORG_SYM, COACH, atFloorCircle);
    await linkCohort(T, ORG_SYM, OTHER_COACH, otherCoachCircle);
    expect((await listCohortLinks(T, ORG_SYM)).map((l) => l.circleId).sort()).toEqual([atFloorCircle, otherCoachCircle].sort());
    // The other coach cannot undo COACH's decision, and vice versa.
    await expect(unlinkCohort(T, ORG_SYM, atFloorCircle, OTHER_COACH)).rejects.toBeInstanceOf(OrgProgramNotFoundError);
    await expect(unlinkCohort(T, ORG_SYM, otherCoachCircle, COACH)).rejects.toBeInstanceOf(OrgProgramNotFoundError);
    await unlinkCohort(T, ORG_SYM, otherCoachCircle, OTHER_COACH);
    expect((await listCohortLinks(T, ORG_SYM)).map((l) => l.circleId)).toEqual([atFloorCircle]);
    await expect(unlinkCohort(T, ORG_SYM, otherCoachCircle, OTHER_COACH)).resolves.toBeUndefined(); // already gone — no-op
    // The report only covers what is linked.
    expect((await orgReport(T, ORG_SYM)).map((c) => c.circleId)).toEqual([atFloorCircle]);
  });
});

describe('the k-floor is exact', () => {
  it(`k-1 active members withholds; exactly k shows buckets; no member is ever named`, async () => {
    await linkCohort(T, ORG_K, COACH, atFloorCircle);
    await linkCohort(T, ORG_K, COACH, belowFloorCircle);
    const cells = await orgReport(T, ORG_K);
    expect(cells.map((c) => c.circleId).sort()).toEqual([atFloorCircle, belowFloorCircle].sort());
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
    const lib = await setLibraryEntry(T, ORG_LIB, 'user:orgd-admin', { challengeId, version: 1, present: true });
    expect(lib.entries).toHaveLength(1);
    expect(lib.entries[0]?.addedBy).toBe('user:orgd-admin');
    expect((await libraryCatalog(T, ORG_LIB)).curated).toBe(true);
    // Idempotent: the same entry again is still one entry.
    expect((await setLibraryEntry(T, ORG_LIB, 'user:orgd-admin', { challengeId, version: 1, present: true })).entries).toHaveLength(1);
    // Remove it: an EMPTY library is "no library" — the full catalog, not "nothing".
    expect((await setLibraryEntry(T, ORG_LIB, 'user:orgd-admin', { challengeId, version: 1, present: false })).entries).toHaveLength(0);
    const after = await libraryCatalog(T, ORG_LIB);
    expect(after.curated).toBe(false);
    expect(after.challenges.map((c) => c.id)).toContain(challengeId);
    // Grade-data KTORG-D1 — an emptied library leaves NO row (a kept empty row blocked
    // deleting the org forever through deleteOrg's refuse-while-populated guard).
    expect(await getLibrary(T, ORG_LIB)).toBeNull();
    // Removing an entry that was never present is a no-op, not an error.
    await expect(setLibraryEntry(T, ORG_LIB, 'user:orgd-admin', { challengeId, version: 1, present: false })).resolves.toBeTruthy();
  });

  // The removal of the last entry is two writes: CAS the row to `entries: []` (the
  // EMPTYING claim), then delete it. A Discover read landing between them — or after
  // an emptier crashed before its delete — finds an EMPTY row. That row must still
  // read as "no library" (the full catalog), never as an allowlist of nothing.
  // Witness: w40g3-od-empty-library (`!lib || lib.entries.length === 0` → `!lib`).
  it('an EMPTY library row (an emptier mid-delete, or a crashed one) still reads as the full catalog', async () => {
    await orgStores.libraries.put({ tenantId: T, orgId: ORG_LIB_EMPTYING, entries: [], updatedAt: new Date().toISOString() });
    expect((await getLibrary(T, ORG_LIB_EMPTYING))?.entries).toEqual([]); // the claim row really is there
    const view = await libraryCatalog(T, ORG_LIB_EMPTYING);
    expect(view.curated).toBe(false);
    expect(view.challenges.map((c) => c.id)).toContain(challengeId);
  });
});

describe('brand ref', () => {
  it('round-trips a trimmed id and refuses empty or oversized ids', async () => {
    expect(await getBrandRef(T, ORG_BRAND)).toBeNull();
    await setBrandRef(T, ORG_BRAND, '  brand:kicktodo  ');
    expect(await getBrandRef(T, ORG_BRAND)).toBe('brand:kicktodo');
    await expect(setBrandRef(T, ORG_BRAND, '   ')).rejects.toBeInstanceOf(OrgProgramError);
    await expect(setBrandRef(T, ORG_BRAND, 'x'.repeat(201))).rejects.toBeInstanceOf(OrgProgramError);
    expect(await getBrandRef(T, ORG_BRAND)).toBe('brand:kicktodo'); // a refused write changes nothing
  });
});
