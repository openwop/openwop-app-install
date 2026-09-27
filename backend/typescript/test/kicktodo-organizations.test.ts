/**
 * ADR 0428 P1–P3 — org programs:
 *  - the library is an ALLOWLIST overlay when present (curated catalog);
 *    absent ⇒ full published catalog
 *  - cohort links bind EXISTING 0419 cohorts; unknown circle → uniform 404
 *  - the report is k-anonymous: a cohort under 5 ACTIVE members yields a
 *    WITHHELD cell (outcome null — never a smaller number); at k it yields
 *    buckets only (no member identities anywhere in the payload)
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
  setLibraryEntry, libraryCatalog, linkCohort, orgReport, OrgProgramNotFoundError, REPORT_K_FLOOR,
} from '../src/features/kicktodo-organizations/orgProgramService.js';

const T = 'tenant-orgprog';
const ORG = 'org:test-1';
const COACH = 'user:orgp-coach';

let challengeA = '';
let challengeB = '';
let bigCircleId = '';
let smallCircleId = '';

async function makeCohort(name: string, challengeId: string, members: number): Promise<string> {
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: COACH, challengeId, challengeVersion: 1, timezone: 'UTC' });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: COACH, name });
  await createCohortDetail({ circle, actorSubject: COACH, capacity: 50, startDateLocal: '2026-07-01' });
  for (let i = 0; i < members; i += 1) {
    const subject = `user:orgp-${name}-${i}`;
    await inviteToCircle(T, circle.id, COACH, subject, ['progress-summary']);
    await joinCohort(circle.id, subject);
  }
  return circle.id;
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
  for (const [label, setter] of [['Org A', (id: string) => (challengeA = id)], ['Org B', (id: string) => (challengeB = id)]] as const) {
    const draft = await createDraft({
      tenantId: T, title: label, summary: 's', outcome: 'o', durationDays: 1,
      activities: [{ stableActivityId: 'x', day: 1, title: 't', instructions: 'i', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(T, draft.id, 1);
    setter(draft.id);
  }
  bigCircleId = await makeCohort('big', challengeA, REPORT_K_FLOOR); // at floor (owner grant adds one more)
  smallCircleId = await makeCohort('small', challengeB, 2);          // below floor
});

describe('org challenge library (P1)', () => {
  it('allowlist overlay when curated; full catalog when absent; unknown challenge 404s', async () => {
    const before = await libraryCatalog(T, ORG);
    expect(before.curated).toBe(false);
    expect(before.challenges.length).toBeGreaterThanOrEqual(2);

    await setLibraryEntry(T, ORG, 'user:orgp-admin', { challengeId: challengeA, version: 1, present: true });
    const curated = await libraryCatalog(T, ORG);
    expect(curated.curated).toBe(true);
    expect(curated.challenges.map((c) => c.id)).toEqual([challengeA]);

    await expect(
      setLibraryEntry(T, ORG, 'user:orgp-admin', { challengeId: 'chal:nope', version: 1, present: true }),
    ).rejects.toBeInstanceOf(OrgProgramNotFoundError);
  });
});

describe('org cohorts + k-anonymous report (P2/P3)', () => {
  it('links existing cohorts; the report floors at k=5 ACTIVE members and carries buckets only', async () => {
    await expect(linkCohort(T, ORG, COACH, 'circle:missing')).rejects.toBeInstanceOf(OrgProgramNotFoundError);
    // KTFULL-B16: the cohort's OWNER links it. An org admin cannot.
    await linkCohort(T, ORG, COACH, bigCircleId);
    await linkCohort(T, ORG, COACH, smallCircleId);

    const cells = await orgReport(T, ORG);
    expect(cells).toHaveLength(2);

    const big = cells.find((c) => c.circleId === bigCircleId)!;
    expect(big.outcome).not.toBeNull();
    expect(big.outcome!.activeMembers).toBeGreaterThanOrEqual(REPORT_K_FLOOR);
    expect(Object.keys(big.outcome!).sort()).toEqual(['activeMembers', 'completedMembers', 'completionRate', 'members']);

    const small = cells.find((c) => c.circleId === smallCircleId)!;
    expect(small.outcome).toBeNull(); // WITHHELD — never a smaller number
    expect(small.withheldReason).toBe('below-k-floor');

    // No member identity anywhere in the report payload.
    expect(JSON.stringify(cells)).not.toContain('user:orgp-');
  });

  // KTFULL-B16 — link validation used to check only that the cohort EXISTED,
  // so any org admin could bind a same-tenant PRIVATE cohort they had nothing
  // to do with and then read its aggregate. The cohort owner never consented,
  // and the accountability aggregate is not gated behind them. Ownership is
  // now the consent signal: a coach links their own cohort, or nobody does.
  it('refuses to link a cohort the actor does not own', async () => {
    await expect(linkCohort(T, ORG, 'user:orgp-admin', bigCircleId))
      .rejects.toBeInstanceOf(OrgProgramNotFoundError);
    // A member of the cohort cannot conscript it either.
    await expect(linkCohort(T, ORG, 'user:orgp-big-0', bigCircleId))
      .rejects.toBeInstanceOf(OrgProgramNotFoundError);
  });
});
