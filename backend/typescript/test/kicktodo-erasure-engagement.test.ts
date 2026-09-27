/**
 * ADR 0458 P0 — kicktodo-engagement data-subject erasure (subjectErasure seam).
 * Every engagement store is subject-keyed personal data (opt-in, stat, awards); a DSAR
 * removes all three for the subject, leaving other subjects and other tenants untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import {
  eraseEngagementSubject, __test,
} from '../src/features/kicktodo-engagement/engagementService.js';

const T = 'tenant-A';
const T2 = 'tenant-B';
const A = 'user:alice';
const B = 'user:bob';

async function seed(tenantId: string, subject: string): Promise<void> {
  await __test.optIns.put({ tenantId, ownerSubject: subject, displayName: `Name ${subject}`, optedInAt: '2026-01-01T00:00:00.000Z' });
  await __test.stats.put({ tenantId, ownerSubject: subject, completedCount: 3, updatedAt: '2026-01-01T00:00:00.000Z' });
  await __test.awards.put({ tenantId, ownerSubject: subject, awardId: `first-check-in::e1`, kind: 'first-check-in', enrollmentId: 'e1', earnedAt: '2026-01-01T00:00:00.000Z' });
  await __test.awards.put({ tenantId, ownerSubject: subject, awardId: `streak-7::e1`, kind: 'streak-7', enrollmentId: 'e1', earnedAt: '2026-01-02T00:00:00.000Z' });
}

async function present(tenantId: string, subject: string): Promise<boolean> {
  const opt = await __test.optIns.get(`${tenantId}::${subject}`);
  const stat = await __test.stats.get(`${tenantId}::${subject}`);
  const awards = await __test.awards.listByPrefix(`${tenantId}::${subject}::`);
  return !!opt || !!stat || awards.length > 0;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await seed(T, A);
  await seed(T, B);
  await seed(T2, A); // same subject id, DIFFERENT tenant — must survive
});

describe('ADR 0458 P0 — engagement subject erasure', () => {
  it('erases the subject in-tenant only; other subject + other tenant intact', async () => {
    await eraseEngagementSubject(T, A);
    expect(await present(T, A)).toBe(false); // fully gone
    expect(await __test.optIns.get(`${T}::${A}`)).toBeNull();
    expect(await __test.stats.get(`${T}::${A}`)).toBeNull();
    expect(await __test.awards.listByPrefix(`${T}::${A}::`)).toHaveLength(0);
    expect(await present(T, B)).toBe(true);  // other subject untouched
    expect(await present(T2, A)).toBe(true); // other tenant untouched
  });

  it('is idempotent and no-ops on a falsy subject', async () => {
    await eraseEngagementSubject(T, A);
    await eraseEngagementSubject(T, A); // second run: no throw, still gone
    expect(await present(T, A)).toBe(false);
    await eraseEngagementSubject(T, '');
    expect(await present(T, B)).toBe(true); // falsy subject touched nothing
  });

  it('runs from the host fan-out (registered at module load)', async () => {
    // The module-load `registerSubjectEraser` wired it into eraseSubject.
    const res = await eraseSubject(T, A);
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(await present(T, A)).toBe(false);
    expect(await present(T, B)).toBe(true);
  });
});
