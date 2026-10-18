/**
 * ADR 0419 P2 — privacy projections + feed + nudge:
 *
 *  - the pure allowlist mapper: summary-only sees COUNTS (no actions); adding
 *    action-status reveals titles+completion but NEVER notes; notes require
 *    the explicit check-in-note scope; measured values project under NO scope
 *  - the live feed applies the caller's grant (revoked → 404 immediately)
 *  - nudge requires the message scope and carries NO progress data
 *
 * Sabotage witnesses (w41 /grade-tests): the note scope gate, the action-status
 * and progress-summary scope gates, the live-grant read (revocation), the
 * nudge's message-scope check, and the nudge emit itself.
 * Honest ceiling: no code path carries `measuredValue` into a projection today,
 * so the `72.125` absence is a tripwire for a future mapper, not a probed guard.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend, getNotificationEmitter } from '../src/notifications/emitter.js';
import type { NotificationRecord } from '../src/types.js';
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

let enrollmentId = '';
let circleSeq = 0;

/** Each case gets its OWN circle, so grant state never leaks between cases (shuffle-safe). */
async function freshCircle(): Promise<AccountabilityCircle> {
  circleSeq += 1;
  return createCircle({ tenantId: T, type: 'partner', enrollmentId, ownerSubject: ALICE, name: `Proj Circle ${circleSeq}` });
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  setNotificationBackend(await openStorage('memory://'));
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
  enrollmentId = enrollment.id;
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
    expect(out.actions).toEqual([{ title: 'Morning pages', completed: true }, { title: 'Walk', completed: false }]);
    expect(out.summary).toBeUndefined(); // counts need their own scope
    expect(JSON.stringify(out)).not.toContain('PRIVATE-JOURNAL-TEXT');
  });

  it('check-in-note (with action-status) → notes appear', () => {
    const out = projectFields(['action-status', 'check-in-note'], progress, actions);
    expect(out.actions?.[0].note).toBe('PRIVATE-JOURNAL-TEXT');
  });
});

describe('the live feed', () => {
  it('applies the grant scopes; measured values project under NO scope; revocation bites immediately', async () => {
    const circle = await freshCircle();
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
    const circle = await freshCircle();
    const captured: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if (n.metadata?.circleId === circle.id) captured.push(n);
    });
    try {
      await inviteToCircle(T, circle.id, ALICE, BOB, ['progress-summary']); // no message scope
      await acceptGrant(circle.id, BOB);
      await expect(nudgeParticipant(await resolveCircleByOpaqueId(circle.id), BOB)).rejects.toBeInstanceOf(CircleDeniedError);
      expect(captured).toHaveLength(0);
      // With the scope, the nudge reaches the PARTICIPANT — and carries no progress data.
      await revokeGrant(T, circle.id, ALICE, BOB);
      await inviteToCircle(T, circle.id, ALICE, BOB, ['message']);
      await acceptGrant(circle.id, BOB);
      await nudgeParticipant(await resolveCircleByOpaqueId(circle.id), BOB);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.recipientUserId).toBe(ALICE);
      const raw = JSON.stringify(captured[0]);
      for (const leak of ['Morning pages', 'Walk', 'PRIVATE-JOURNAL-TEXT', '72.125', 'completedActivities']) {
        expect(raw).not.toContain(leak);
      }
    } finally {
      unsub();
    }
  });
});
