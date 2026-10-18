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
  eraseEngagementSubject, optIn, optOut, myOptIn, __test,
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

/** Per-STORE read-back. (An OR-ed `present()` used to stand in here: it stayed
 *  true while ANY one store survived, so wiping a co-subject's awards was
 *  invisible — w40 probe ee-awards-whole-tenant.) */
async function stores(tenantId: string, subject: string): Promise<{ opt: boolean; stat: boolean; awards: number }> {
  const opt = await __test.optIns.get(`${tenantId}::${subject}`);
  const stat = await __test.stats.get(`${tenantId}::${subject}`);
  const awards = await __test.awards.listByPrefix(`${tenantId}::${subject}::`);
  return { opt: !!opt, stat: !!stat, awards: awards.length };
}
const GONE = { opt: false, stat: false, awards: 0 };
const INTACT = { opt: true, stat: true, awards: 2 };

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await seed(T, A);
  await seed(T, B);
  await seed(T2, A); // same subject id, DIFFERENT tenant — must survive
});

describe('ADR 0458 P0 — engagement subject erasure', () => {
  it('erases the subject in-tenant only; other subject + other tenant intact', async () => {
    expect(await stores(T, A)).toEqual(INTACT); // precondition: there was something to erase
    await eraseEngagementSubject(T, A);
    expect(await stores(T, A)).toEqual(GONE);    // every store, fully gone
    expect(await stores(T, B)).toEqual(INTACT);  // other subject: EVERY store untouched
    expect(await stores(T2, A)).toEqual(INTACT); // other tenant: EVERY store untouched
  });

  it('is idempotent and no-ops on a falsy subject', async () => {
    await eraseEngagementSubject(T, A);
    await eraseEngagementSubject(T, A); // second run: no throw, still gone
    expect(await stores(T, A)).toEqual(GONE);
    // The falsy guard is only observable against rows whose subject IS empty
    // (malformed/legacy): an unguarded '' would delete exactly those.
    await seed(T, '');
    await eraseEngagementSubject(T, '');
    expect(await stores(T, '')).toEqual(INTACT);
    expect(await stores(T, B)).toEqual(INTACT);
  });

  it('runs from the host fan-out (registered at module load)', async () => {
    // The module-load `registerSubjectEraser` wired it into eraseSubject.
    await eraseSubject(T, A);
    expect(await stores(T, A)).toEqual(GONE);
    expect(await stores(T, B)).toEqual(INTACT);
    expect(await stores(T2, A)).toEqual(INTACT);
  });
});

/**
 * KTENG-1 (KickTodo wave 4C) — opting out withdraws the consent to SHOW the
 * free-text `displayName`, so the name must not outlive it on the row (before
 * this, only a DSAR removed it). Breaks if `optOut` keeps `...row`'s
 * `displayName` (sabotage-witnessed: reverting the `displayName: ''` override
 * reddens the first expectation).
 */
describe('KTENG-1 — opt-out clears the free-text displayName', () => {
  it('drops the name on opt-out, keeps the revoked row, and a re-opt-in takes a fresh name', async () => {
    await optIn(T, 'user:carol', 'Carol Danvers');
    await optOut(T, 'user:carol');
    const row = await __test.optIns.get(`${T}::user:carol`);
    expect(row?.displayName).toBe('');
    expect(row?.revokedAt).toBeTruthy(); // opt-out history kept
    expect(await myOptIn(T, 'user:carol')).toBeNull();
    // Other members' names untouched.
    expect((await __test.optIns.get(`${T}::${B}`))?.displayName).toBe(`Name ${B}`);
    await optIn(T, 'user:carol', 'C.');
    expect((await myOptIn(T, 'user:carol'))?.displayName).toBe('C.');
  });
});
