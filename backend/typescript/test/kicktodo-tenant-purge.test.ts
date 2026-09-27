/**
 * KTD-1 RETRACTION (2026-07-19) — proving the claim rather than asserting it.
 *
 * The DATA assessment recorded `kicktodo-feed-tokens` as a "double-blind" row:
 * hash-keyed with no tenant prefix, therefore (it claimed) unreachable by a
 * tenant teardown. That was WRONG. `DurableCollection.purgeTenantRows` is a
 * CONTENT scan over the collection's own `hostext:<name>:` prefix, matching the
 * row's `tenantId` — it never requires the KEY to embed the tenant.
 *
 * This test pins the real behaviour for the three keyspaces the assessment
 * doubted, so the retraction cannot silently regress:
 *   - feed tokens (hash-keyed, tenant ONLY in content) — the disputed one
 *   - seat holds, COHORT SEATS, and verifier samples (tenant-prefixed keys)
 * and proves the purge is tenant-SCOPED (a sibling tenant's rows survive).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, purgeTenantHostExt, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { todayFor, submitCheckIn } from '../src/features/kicktodo-core/todayService.js';
import { evaluateEnrollment } from '../src/features/kicktodo-core/progressService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { grantConsent, mintFeedToken, renderFeed, FeedDeniedError } from '../src/features/kicktodo-integrations/integrationService.js';
import { kicktodoIntegrationsFeature } from '../src/features/kicktodo-integrations/feature.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCircle } from '../src/features/kicktodo-accountability/circleService.js';
import { confirmSeat, createCohortDetail, getCohortDetail, holdSeat, liveHold, reconcileSeats } from '../src/features/kicktodo-accountability/cohortService.js';
import { sampleVerdict, verifierQuality } from '../src/features/kicktodo-metrics/verifierSampleService.js';

const A = 'tenant-purge-a';
const B = 'tenant-purge-b';

/** KTD-11 — RAW probe of the `kicktodo-cohort-seats` keyspace. The collection is
 *  keyed `${tenantId}::${circleId}::${subject}`, so the row key is
 *  `hostext:kicktodo-cohort-seats:<tenant>::…`. Reading the bytes (rather than
 *  a service accessor) is the point: it proves the ROWS are gone, not merely
 *  that some derived read returns empty. */
async function seatRowKeys(tenantId: string): Promise<string[]> {
  const rows = await hostExtStorage().kvList(`hostext:kicktodo-cohort-seats:${tenantId}::`);
  return rows.map((r) => r.key);
}

async function seedTenant(tenantId: string): Promise<{ token: string; circleId: string; enrollmentId: string }> {
  const draft = await createDraft({
    tenantId, title: 'Purge', summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenantId, draft.id, 1);
  const owner = `user:purge-${tenantId}`;
  const { enrollment } = await enroll({ tenantId, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });

  await grantConsent(tenantId, owner, 'calendar-project');
  const token = await mintFeedToken(tenantId, owner);           // HASH-keyed row

  const circle = await createCircle({ tenantId, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: owner, name: 'C' });
  await createCohortDetail({ circle, actorSubject: owner, capacity: 5, startDateLocal: '2099-01-01' });
  await holdSeat(tenantId, circle.id, `user:buyer-${tenantId}`);
  // CR-2 — a real SEAT row in the new `kicktodo-cohort-seats` ledger, so
  // teardown is proven for it and not merely assumed from the hold.
  await confirmSeat(tenantId, circle.id, `user:seated-${tenantId}`);
  const card = (await todayFor(tenantId, owner)).enrollments[0]?.actions[0]?.occurrence.cardId;
  if (card) await submitCheckIn(tenantId, owner, card, {});
  await evaluateEnrollment(tenantId, enrollment.id, owner);
  await sampleVerdict(tenantId, { enrollmentId: enrollment.id, submittedBy: owner });

  return { token, circleId: circle.id, enrollmentId: enrollment.id };
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault(kicktodoIntegrationsFeature.toggleDefault!);
  await saveConfig({ ...kicktodoIntegrationsFeature.toggleDefault!, status: 'on' }, 'test');
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('tenant teardown reaches every KickTodo keyspace (KTD-1 retraction)', () => {
  it('purges HASH-KEYED feed tokens — the row the assessment wrongly called unreachable', async () => {
    const a = await seedTenant(A);
    await expect(renderFeed(a.token)).resolves.toContain('BEGIN:VCALENDAR'); // live before

    const result = await purgeTenantHostExt(A);
    expect(result.deleted).toBeGreaterThan(0);

    // The hash-keyed token row is GONE — content-matched, not prefix-matched.
    await expect(renderFeed(a.token)).rejects.toBeInstanceOf(FeedDeniedError);
  });

  it('purges tenant-prefixed seat holds, cohort seats, and verifier samples too', async () => {
    const a = await seedTenant(A);
    expect(await liveHold(A, a.circleId, `user:buyer-${A}`)).not.toBeNull();
    expect((await verifierQuality(A)).sampled).toBe(1);
    // Non-vacuous: the seat ledger must be POPULATED before the purge, or the
    // post-purge `toEqual([])` below would pass against a keyspace that never
    // had a row (e.g. if `confirmSeat` stopped writing one).
    expect(await seatRowKeys(A)).toHaveLength(1);

    await purgeTenantHostExt(A);

    expect(await liveHold(A, a.circleId, `user:buyer-${A}`)).toBeNull();
    expect((await verifierQuality(A)).sampled).toBe(0);
    // The cohort row itself is gone, so the seat ledger has nothing to point
    // at; reconcile resolves to null rather than to a surviving seat count.
    expect(await getCohortDetail(A, a.circleId)).toBeNull();
    await expect(reconcileSeats(A, a.circleId)).resolves.toBeNull();
    // KTD-11 — the two assertions above pass WITHOUT the seat ledger ever being
    // read: `reconcileSeats` returns null off the missing cohort row before it
    // touches `kicktodo-cohort-seats`. Teardown of the seat rows was therefore
    // inferred, not proven. Probe the keyspace directly.
    expect(await seatRowKeys(A)).toEqual([]);
  });

  it('is tenant-SCOPED — a sibling tenant survives untouched', async () => {
    const a = await seedTenant(A);
    const b = await seedTenant(B);

    await purgeTenantHostExt(A);

    await expect(renderFeed(a.token)).rejects.toBeInstanceOf(FeedDeniedError); // purged
    await expect(renderFeed(b.token)).resolves.toContain('BEGIN:VCALENDAR');   // untouched
    expect((await verifierQuality(B)).sampled).toBe(1);
    expect(await liveHold(B, b.circleId, `user:buyer-${B}`)).not.toBeNull();
    // KTD-11 — the seat ledger is tenant-scoped too: A's rows are gone, B's stand.
    expect(await seatRowKeys(A)).toEqual([]);
    expect(await seatRowKeys(B)).toHaveLength(1);
  });
});
