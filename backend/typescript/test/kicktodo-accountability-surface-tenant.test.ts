/**
 * Code-grade KTA-1 (2026-10-14) — the `kicktodo-accountability` workflow surface is
 * bound to the run's tenant. Circle ids are opaque and resolve across tenants (the
 * grantee index is cross-workspace by design, for the coach's own console route),
 * so before this a workflow in tenant B could read tenant A's circle feed, list a
 * coach's tenant-A caseload, or raise a proposal on a tenant-A circle, given an id
 * and a subject with a live grant there.
 *
 * TST-DJC-2 (grade-tests wave 71). The ADR 0901 run-principal binding is OFF by
 * default, so `circleInTenant` (surface.ts) is the ONLY guard on feed/propose, and
 * `coachCaseload`'s `opts.tenantId` filter (cohortService.ts) the only one on the
 * caseload. The cross-tenant id is a REAL tenant-HOME circle, so the case reaches
 * the fence. Red when: the `circle.tenantId !== tenant` check is dropped, feed or
 * propose stop calling it, the surface stops passing `{ tenantId }` to the caseload,
 * or the caseload filter is dropped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { createCircle, inviteToCircle, acceptGrant, CircleDeniedError } from '../src/features/kicktodo-accountability/circleService.js';
import { coachCaseload, indexGrantee } from '../src/features/kicktodo-accountability/cohortService.js';
import { buildKicktodoAccountabilitySurface } from '../src/features/kicktodo-accountability/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

const HOME = 'tenant-acct-surface-home';
const OTHER = 'tenant-acct-surface-other';
const OWNER = 'user:acct-surface-owner';
const COACH = 'user:acct-surface-coach';
let circleId = '';

function recordOf(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} is not an object: ${JSON.stringify(v)}`);
  return { ...v };
}

function surfaceFor(tenantId: string) {
  const scope: BundleScope = { tenantId };
  return buildKicktodoAccountabilitySurface(scope);
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: HOME, title: 'Coached', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(HOME, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: HOME, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1 });
  const circle = await createCircle({ tenantId: HOME, type: 'coach', enrollmentId: enrollment.id, ownerSubject: OWNER, name: 'Coached circle' });
  await inviteToCircle(HOME, circle.id, OWNER, COACH, ['action-status', 'coach-plan-proposal']);
  await acceptGrant(circle.id, COACH);
  // The cohort/coach join path writes this caseload pointer (as kicktodo-coach-console.test.ts does).
  await indexGrantee(COACH, circle.id, HOME);
  circleId = circle.id;
});

describe('accountability surface is bound to the run tenant', () => {
  it('the home tenant reads the feed, the caseload and can propose', async () => {
    const s = surfaceFor(HOME);
    const feed = recordOf((await s.feed!({ circleId, callerSubject: COACH })).feed, 'feed');
    expect(feed.circleId).toBe(circleId);
    expect(Array.isArray(feed.actions)).toBe(true); // the coach holds `action-status`
    const { caseload } = await s.caseload!({ coachSubject: COACH });
    if (!Array.isArray(caseload)) throw new Error('caseload is not an array');
    expect(caseload.map((r) => recordOf(r, 'caseload row').circleId)).toEqual([circleId]);
    const proposal = recordOf((await s.propose!({ circleId, coachSubject: COACH, note: 'try mornings' })).proposal, 'proposal');
    expect(proposal).toMatchObject({ tenantId: HOME, circleId, coachSubject: COACH, state: 'proposed' });
  });

  it('another tenant gets nothing: feed and propose are denied, the caseload is empty', async () => {
    const s = surfaceFor(OTHER);
    await expect(s.feed!({ circleId, callerSubject: COACH })).rejects.toBeInstanceOf(CircleDeniedError);
    await expect(s.propose!({ circleId, coachSubject: COACH, note: 'x' })).rejects.toBeInstanceOf(CircleDeniedError);
    const { caseload } = await s.caseload!({ coachSubject: COACH });
    expect(caseload).toEqual([]);
  });

  it('the coach console route (no tenant filter) still reads across workspaces', async () => {
    expect((await coachCaseload(COACH)).length).toBe(1);
  });
});
