/**
 * ADR 0432 P3 igniter (chat-first-port G9) — the verifier-sample daemon.
 *
 * The FP/FN metric was structurally starved: `sampleVerdict` + `verifierQuality`
 * shipped, but nothing minted samples on a cadence. This proves the cadence:
 *  - a metrics-ENABLED tenant with judged verdicts gets a deterministic sample
 *    minted through the SAME `sampleVerdict` path (verdict read from the judge);
 *  - the monthly slot claim makes a re-fire within the period a no-op (idempotent);
 *  - a tenant WITHOUT kicktodo-metrics enabled is never sampled (toggle honesty);
 *  - an enrollment the judge has not ruled on is skipped (no fabricated verdict).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { evaluateEnrollment } from '../src/features/kicktodo-core/progressService.js';
import { verifierQuality } from '../src/features/kicktodo-metrics/verifierSampleService.js';
import { kicktodoMetricsFeature } from '../src/features/kicktodo-metrics/feature.js';
import { processDueVerifierSamples, yearMonth } from '../src/features/kicktodo-metrics/verifierSampleDaemon.js';

const T = 'tenant-verifier-daemon';
const NOW = Date.parse('2026-07-22T12:00:00.000Z');

let storage: Storage;

/** Seed `n` participants (each with a check-in), then have the judge rule on
 *  each so its enrollment carries a `lastVerdict` and is sampleable. Returns
 *  the enrollment ids in order. */
async function seedJudged(n: number): Promise<string[]> {
  const draft = await createDraft({
    tenantId: T, title: 'Measured', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const owner = `user:v-${i}`;
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    const today = await todayFor(T, owner);
    const card = today.enrollments[0]?.actions[0]?.occurrence.cardId;
    if (card) await submitCheckIn(T, owner, card, {});
    await evaluateEnrollment(T, enrollment.id, owner);
    ids.push(enrollment.id);
  }
  return ids;
}

function enableMetrics(): void {
  // A minimal boot does not populate the toggle registry, so register the
  // metrics default AS enabled — `resolveOne` reads the registry default when no
  // stored override exists.
  registerToggleDefault({ ...kicktodoMetricsFeature.toggleDefault!, status: 'on' });
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetToggleDefaults(); // start each case with no toggle known (default: disabled ⇒ skip)
  // The registered judge rules NOT satisfied — the sample records THAT verdict.
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('verifier-sample daemon (ADR 0432 P3 / G9)', () => {
  it('mints a sample per judged verdict for a metrics-enabled tenant', async () => {
    enableMetrics();
    await seedJudged(3);
    const minted = await processDueVerifierSamples({ storage }, async () => [T], NOW);
    expect(minted).toBe(3);
    const q = await verifierQuality(T);
    expect(q.sampled).toBe(3);
    expect(q.resolved).toBe(0); // minted-but-ungraded ⇒ no rate yet
    expect(q.disagreementRate).toBeNull();
  });

  it('is idempotent within a period — the monthly slot claim fires once', async () => {
    enableMetrics();
    await seedJudged(2);
    const first = await processDueVerifierSamples({ storage }, async () => [T], NOW);
    expect(first).toBe(2);
    // Same period ⇒ the slot is already claimed ⇒ zero new work, no double-sample.
    const again = await processDueVerifierSamples({ storage }, async () => [T], NOW);
    expect(again).toBe(0);
    expect((await verifierQuality(T)).sampled).toBe(2);
  });

  it('skips a tenant that has NOT enabled kicktodo-metrics (toggle honesty)', async () => {
    // No saveConfig ⇒ the metrics toggle resolves disabled/unknown for T.
    await seedJudged(2);
    const minted = await processDueVerifierSamples({ storage }, async () => [T], NOW);
    expect(minted).toBe(0);
    expect((await verifierQuality(T)).sampled).toBe(0);
  });

  it('skips an enrollment the judge has not ruled on (no fabricated verdict)', async () => {
    enableMetrics();
    // A judged one + an UNJUDGED one (enrolled, no evaluateEnrollment).
    await seedJudged(1);
    const owner = 'user:v-unjudged';
    const draft = await createDraft({
      tenantId: T, title: 'Unjudged', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(T, draft.id, 1);
    await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    const minted = await processDueVerifierSamples({ storage }, async () => [T], NOW);
    expect(minted).toBe(1); // only the judged one
  });

  it('yearMonth is a stable UTC YYYY-MM slot', () => {
    expect(yearMonth(Date.parse('2026-07-22T23:59:00.000Z'))).toBe('2026-07');
    expect(yearMonth(Date.parse('2026-12-01T00:00:00.000Z'))).toBe('2026-12');
  });
});
