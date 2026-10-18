/**
 * ADR 0462 Phase 3 — the stale-wearable-stream exception source (the fifth ADR 0460
 * source, unblocked by the liveness clock). Pins the HONEST JOIN that avoids the
 * false positives ADR 0460 deferred over: fires ONLY for a stream that reported then
 * went quiet AND still has live consent AND an active enrollment.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetExceptionSources, listExceptions } from '../src/host/exceptionProjection.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __test as enrollmentStore } from '../src/features/kicktodo-core/enrollmentService.js';
import { grantConsent, revokeConsent } from '../src/features/kicktodo-integrations/integrationService.js';
import { __putWearableLivenessForTest, recordWearableReading, listStaleWearableStreams, __resetWearableLiveness } from '../src/features/kicktodo-integrations/wearableLivenessService.js';
import { registerKicktodoWearableStaleExceptionSource } from '../src/features/kicktodo-integrations/exceptionSources.js';

const T = 'tenant-stale';
const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString(); // 400d ago
const staleRows = async () => (await listExceptions(T)).rows.filter((r) => r.source === 'kicktodo:wearable-stale');

async function enrollActive(subject: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'C', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: subject, challengeId: draft.id, challengeVersion: 1 });
  return enrollment.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  await __resetWearableLiveness();
  __resetExceptionSources();
  registerKicktodoWearableStaleExceptionSource();
});

describe('the liveness clock', () => {
  it('flags only a stream older than the threshold; a fresh one is not stale', async () => {
    await recordWearableReading(T, 'user:fresh');
    await __putWearableLivenessForTest(T, 'user:old', OLD);
    const stale = await listStaleWearableStreams(T, 48 * 3_600_000);
    expect(stale.map((s) => s.ownerSubject)).toEqual(['user:old']);
  });
});

describe('the stale-wearable exception source — honest join (ADR 0462 P3)', () => {
  it('FIRES for stale + live consent + active enrollment', async () => {
    const s = 'user:stale-real';
    await grantConsent(T, s, 'wearable-evidence');
    await enrollActive(s);
    await __putWearableLivenessForTest(T, s, OLD);
    const rows = await staleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner.ref).toBe(s);
    expect(rows[0]!.severity).toBe('attention');
  });

  it('SKIPS when consent was revoked (expected-quiet, not an exception)', async () => {
    // Stale AND actively enrolled — so ONLY the consent check can skip it.
    const s = 'user:revoked';
    await grantConsent(T, s, 'wearable-evidence');
    await enrollActive(s);
    await __putWearableLivenessForTest(T, s, OLD);
    expect((await staleRows()).map((r) => r.owner.ref)).toEqual([s]); // positive control: it fires while consented
    await revokeConsent(T, s, 'wearable-evidence');
    expect(await staleRows()).toEqual([]);
  });

  it('SKIPS when there is no active enrollment (completed/never-enrolled — expected-quiet)', async () => {
    const s = 'user:no-enroll';
    await grantConsent(T, s, 'wearable-evidence');
    await __putWearableLivenessForTest(T, s, OLD); // stale + consent, but no enrollment
    expect(await staleRows()).toEqual([]);
  });

  it('SKIPS when the only enrollment is COMPLETED (an enrollment exists, but none is active)', async () => {
    const s = 'user:completed';
    await grantConsent(T, s, 'wearable-evidence');
    const enrollmentId = await enrollActive(s);
    await __putWearableLivenessForTest(T, s, OLD);
    expect(await staleRows()).toHaveLength(1); // positive control: fires while active
    const row = await enrollmentStore.enrollments.get(`${T}::${enrollmentId}`);
    if (!row) throw new Error('precondition: the enrollment row exists');
    await enrollmentStore.enrollments.put({ ...row, state: 'completed' });
    expect(await staleRows()).toEqual([]);
  });

  it('SKIPS a fresh stream (reported recently)', async () => {
    const s = 'user:fresh-real';
    await grantConsent(T, s, 'wearable-evidence');
    await enrollActive(s);
    await recordWearableReading(T, s); // fresh — NOW
    expect(await staleRows()).toEqual([]);
  });
});
