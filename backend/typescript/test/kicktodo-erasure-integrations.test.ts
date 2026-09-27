/**
 * ADR 0458 P0 — kicktodo-integrations data-subject erasure. Every integration lane is the
 * subject's own consent/connection surface: a DSAR deletes the subject's consents, feed
 * tokens, and wearable-evidence rules (the last resolved through the subject's enrollments,
 * since a rule is enrollment-keyed). Other subjects and other tenants are untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { __test as coreTest } from '../src/features/kicktodo-core/enrollmentService.js';
import type { ChallengeEnrollment } from '../src/features/kicktodo-core/types.js';
import {
  eraseIntegrationsSubject, __test,
} from '../src/features/kicktodo-integrations/integrationService.js';

const T = 'tenant-A';
const T2 = 'tenant-B';
const A = 'user:alice';
const B = 'user:bob';

function enrollment(tenantId: string, subject: string, id: string): ChallengeEnrollment {
  return {
    id, tenantId, ownerSubject: subject, challengeId: 'c1', challengeVersion: 1, challengeContentHash: 'h',
    state: 'active', goalId: 'g1', boardId: 'b1', planRevision: 1, timezone: 'UTC',
    startDateLocal: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function seed(tenantId: string, subject: string, enrollId: string, tokenHash: string): Promise<void> {
  await __test.consents.put({ tenantId, ownerSubject: subject, kind: 'calendar-project', grantedAt: '2026-01-01T00:00:00.000Z' });
  await __test.consents.put({ tenantId, ownerSubject: subject, kind: 'wearable-evidence', grantedAt: '2026-01-01T00:00:00.000Z' });
  await __test.feeds.put({ tokenHash, tenantId, ownerSubject: subject, createdAt: '2026-01-01T00:00:00.000Z' });
  await coreTest.enrollments.put(enrollment(tenantId, subject, enrollId));
  await __test.rules.put({ tenantId, enrollmentId: enrollId, stableActivityId: 'act', metric: 'steps', threshold: 5000, createdAt: '2026-01-01T00:00:00.000Z' });
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await seed(T, A, 'enr-A', 'hash-A');
  await seed(T, B, 'enr-B', 'hash-B');
  await seed(T2, A, 'enr-A2', 'hash-A2');
});

async function consentCount(tenantId: string, subject: string): Promise<number> {
  return (await __test.consents.listByPrefix(`${tenantId}::${subject}::`)).length;
}

describe('ADR 0458 P0 — integrations subject erasure', () => {
  it('erases consents, feed tokens, and wearable rules for the subject; others intact', async () => {
    await eraseIntegrationsSubject(T, A);
    expect(await consentCount(T, A)).toBe(0);
    expect(await __test.feeds.get('hash-A')).toBeNull();
    expect(await __test.rules.get(`${T}::enr-A::act`)).toBeNull();

    // Other subject in-tenant untouched.
    expect(await consentCount(T, B)).toBe(2);
    expect(await __test.feeds.get('hash-B')).not.toBeNull();
    expect(await __test.rules.get(`${T}::enr-B::act`)).not.toBeNull();
    // Same subject id in another tenant untouched.
    expect(await consentCount(T2, A)).toBe(2);
    expect(await __test.feeds.get('hash-A2')).not.toBeNull();
    expect(await __test.rules.get(`${T2}::enr-A2::act`)).not.toBeNull();
  });

  it('is idempotent and no-ops on a falsy subject', async () => {
    await eraseIntegrationsSubject(T, A);
    await eraseIntegrationsSubject(T, A);
    expect(await consentCount(T, A)).toBe(0);
    await eraseIntegrationsSubject(T, '');
    expect(await consentCount(T, B)).toBe(2);
  });

  it('runs from the host fan-out (registered at module load)', async () => {
    await eraseSubject(T, A);
    expect(await consentCount(T, A)).toBe(0);
    expect(await consentCount(T, B)).toBe(2);
  });
});

/**
 * `PROBE-0462-2` — the END-TO-END half.
 *
 * The row asks: after a DSAR on a subject, are `kicktodo-wearable-link:*` and
 * `kicktodo-wearable-liveness:*` erased? I recorded it PARTIAL in #2991 because
 * two things were true and a third was not: both services DO register erasers
 * (`wearableLinkService.ts:109`, `wearableLivenessService.ts:53`), and both sit
 * inside the source-derived denominator of `subject-erasure-feature-stores`, so
 * a NEW unerased feature store fails the build. What was missing is the only
 * thing that proves the wiring: driving the HOST `eraseSubject` seam and looking
 * at the rows.
 *
 * The link eraser reads through `listForTenantIndexed`. That matters: a
 * tenant-index miss returns an EMPTY slice, the loop deletes nothing, and the
 * eraser returns cleanly — a failed read presenting as a completed erasure. The
 * presence precondition below is what separates "erased" from "never seen".
 */
describe('PROBE-0462-2 (executable) — DSAR reaches wearable link + liveness', () => {
  it('erases the subject\'s link and liveness rows, leaving another subject intact', async () => {
    const { linkWearableProvider, listWearableLinksForSubject } =
      await import('../src/features/kicktodo-integrations/wearableLinkService.js');
    const { __putWearableLivenessForTest, listStaleWearableStreams } =
      await import('../src/features/kicktodo-integrations/wearableLivenessService.js');

    for (const s of [A, B]) {
      await __test.consents.put({ tenantId: T, ownerSubject: s, kind: 'wearable-evidence', grantedAt: '2026-01-01T00:00:00.000Z' });
      await linkWearableProvider(T, s, 'fitbit', `pu-${s}`);
      await __putWearableLivenessForTest(T, s, '2026-01-01T00:00:00.000Z');
    }

    // PRECONDITION — without this, "no rows" below is true for a subject that
    // never had any, which is exactly how a tenant-index miss would read.
    expect((await listWearableLinksForSubject(T, A)), 'alice had no link to erase — the assertion would be vacuous').toHaveLength(1);
    const staleBefore = await listStaleWearableStreams(T, 0);
    expect(staleBefore.some((x) => x.ownerSubject === A), 'alice had no liveness row to erase').toBe(true);

    await eraseSubject(T, A);

    expect(await listWearableLinksForSubject(T, A), 'the wearable LINK survived a DSAR').toHaveLength(0);
    const staleAfter = await listStaleWearableStreams(T, 0);
    expect(staleAfter.some((x) => x.ownerSubject === A), 'the wearable LIVENESS row survived a DSAR').toBe(false);

    // Scoped, not a purge.
    expect(await listWearableLinksForSubject(T, B), 'another subject\'s link was erased').toHaveLength(1);
    expect(staleAfter.some((x) => x.ownerSubject === B), 'another subject\'s liveness row was erased').toBe(true);
  });
});
