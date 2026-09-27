/**
 * ADR 0419 P2 — privacy projections + feed + nudge:
 *
 *  - the pure allowlist mapper: summary-only sees COUNTS (no actions); adding
 *    action-status reveals titles+completion but NEVER notes; notes require
 *    the explicit check-in-note scope; measured values project under NO scope
 *  - the live feed applies the caller's grant (revoked → 404 immediately)
 *  - nudge requires the message scope and carries NO progress data
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn } from '../src/features/kicktodo-core/todayService.js';
import {
  createCircle,
  inviteToCircle,
  acceptGrant,
  revokeGrant,
  resolveCircleByOpaqueId,
  CircleDeniedError,
  type AccountabilityCircle,
} from '../src/features/kicktodo-accountability/circleService.js';
import { circleFeedFor, nudgeParticipant, projectFields } from '../src/features/kicktodo-accountability/projectionService.js';

const T = 'tenant-projection';
const ALICE = 'user:proj-alice';
const BOB = 'user:proj-bob';

let circle: AccountabilityCircle;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Projected Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [
      { stableActivityId: 'a1', day: 1, title: 'Morning pages', instructions: 'private instructions', evidencePolicy: 'note' },
      { stableActivityId: 'a2', day: 1, title: 'Walk', instructions: '', evidencePolicy: 'attestation' },
    ],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: ALICE, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  // Complete one action WITH a private journal note.
  const today = await todayFor(T, ALICE);
  const first = today.enrollments[0].actions.find((a) => a.card?.title.includes('Morning pages'))!;
  await submitCheckIn(T, ALICE, first.occurrence.cardId, { note: 'PRIVATE-JOURNAL-TEXT', measuredValue: 72.125 });
  circle = await createCircle({ tenantId: T, type: 'partner', enrollmentId: enrollment.id, ownerSubject: ALICE, name: 'Proj Circle' });
});

describe('the pure allowlist mapper', () => {
  const progress = { currentDay: 1, durationDays: 3, completedActivities: 1, totalRequiredActivities: 2, state: 'active' };
  const actions = [
    { title: 'Morning pages', completed: true, note: 'PRIVATE-JOURNAL-TEXT' },
    { title: 'Walk', completed: false },
  ];

  it('progress-summary alone → counts only, no actions', () => {
    const out = projectFields(['progress-summary'], progress, actions);
    expect(out.summary?.completedActivities).toBe(1);
    expect(out.actions).toBeUndefined();
  });

  it('action-status → titles + completion, NEVER notes', () => {
    const out = projectFields(['action-status'], progress, actions);
    expect(out.actions).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain('PRIVATE-JOURNAL-TEXT');
  });

  it('check-in-note (with action-status) → notes appear', () => {
    const out = projectFields(['action-status', 'check-in-note'], progress, actions);
    expect(out.actions?.[0].note).toBe('PRIVATE-JOURNAL-TEXT');
  });
});

describe('the live feed', () => {
  it('applies the grant scopes; measured values project under NO scope; revocation bites immediately', async () => {
    await inviteToCircle(T, circle.id, ALICE, BOB, ['progress-summary', 'action-status']);
    await acceptGrant(circle.id, BOB);

    const feed = await circleFeedFor(await resolveCircleByOpaqueId(circle.id), BOB);
    expect(feed.summary?.totalRequiredActivities).toBe(2);
    expect(feed.actions?.some((a) => a.title.includes('Morning pages') && a.completed)).toBe(true);
    const raw = JSON.stringify(feed);
    expect(raw).not.toContain('PRIVATE-JOURNAL-TEXT'); // no note scope
    expect(raw).not.toContain('72.125');                // measured values: never (decimal sentinel — a random uuid can contain bare '72', which flaked this test)
    expect(raw).not.toContain('private instructions');  // instructions: never

    await revokeGrant(T, circle.id, ALICE, BOB);
    await expect(circleFeedFor(await resolveCircleByOpaqueId(circle.id), BOB)).rejects.toBeInstanceOf(CircleDeniedError);
  });
});

describe('nudge', () => {
  it('requires the message scope', async () => {
    await inviteToCircle(T, circle.id, ALICE, BOB, ['progress-summary']); // no message scope
    await acceptGrant(circle.id, BOB);
    await expect(nudgeParticipant(await resolveCircleByOpaqueId(circle.id), BOB)).rejects.toBeInstanceOf(CircleDeniedError);
    // With the scope, the nudge succeeds (emit is best-effort in minimal boots).
    await revokeGrant(T, circle.id, ALICE, BOB);
    await inviteToCircle(T, circle.id, ALICE, BOB, ['message']);
    await acceptGrant(circle.id, BOB);
    await nudgeParticipant(await resolveCircleByOpaqueId(circle.id), BOB); // resolves without throwing
  });
});
