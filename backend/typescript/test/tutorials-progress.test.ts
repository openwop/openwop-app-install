/**
 * ADR 0488 D4 — tutorial progress, and its ADR 0464 privacy obligation.
 *
 * This file is the store's SELF-POLICING. `test/subject-erasure-coverage.test.ts`
 * enumerates only `src/host/**`, so a subject-bearing collection declared under
 * `src/features/` is NOT caught by that build gate (recorded as `DATA-T2` in the
 * `/grade-data` pass). The erasure assertions below are therefore the only thing
 * standing between this store and the exact defect class ADR 0464 exists to kill.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  listTutorialProgress,
  putTutorialProgress,
  eraseTutorialProgressForSubject,
  normalizeStepIds,
  __clearTutorialProgressForTests,
} from '../src/features/tutorials/progressStore.js';

const T1 = 'tenant-1';
const T2 = 'tenant-2';
const ALICE = 'user:alice-hash';
const BOB = 'user:bob-hash';

// The store is a DurableCollection, so storage must exist before any read.
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(__clearTutorialProgressForTests);

describe('ADR 0488 D4 — tutorial progress store', () => {
  it('round-trips one user\'s progress', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'connect-your-ai', completedStepIds: ['1.1', '2.1'] });
    const rows = await listTutorialProgress(T1, ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.completedStepIds).toEqual(['1.1', '2.1']);
  });

  it('is IDEMPOTENT — a repeated write updates in place, never duplicates', async () => {
    for (let i = 0; i < 3; i++) {
      await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'connect-your-ai', completedStepIds: ['1.1'] });
    }
    expect(await listTutorialProgress(T1, ALICE)).toHaveLength(1);
  });

  it('NEVER leaks another member\'s progress (the ADR 0378 resume-hijack class)', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'connect-your-ai', completedStepIds: ['1.1'] });
    await putTutorialProgress({ tenantId: T1, userId: BOB, tutorialId: 'connect-your-ai', completedStepIds: ['1.1', '2.1', '3.1'] });
    const alice = await listTutorialProgress(T1, ALICE);
    expect(alice).toHaveLength(1);
    expect(alice[0]!.userId).toBe(ALICE);
    expect(alice[0]!.completedStepIds).toEqual(['1.1']); // NOT Bob's three
  });

  it('is tenant-isolated', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'x', completedStepIds: ['1.1'] });
    expect(await listTutorialProgress(T2, ALICE)).toEqual([]);
  });

  it('keys survive a subject containing colons (constructed, never parsed)', async () => {
    // `user:alice-hash` already contains ':' — a key PARSER would split wrongly.
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'a:b:c', completedStepIds: ['1.1'] });
    const rows = await listTutorialProgress(T1, ALICE);
    expect(rows[0]!.tutorialId).toBe('a:b:c');
    expect(rows[0]!.userId).toBe(ALICE);
  });
});

describe('normalizeStepIds — the client is not trusted to bound itself', () => {
  it('drops non-strings, blanks, and duplicates', () => {
    expect(normalizeStepIds(['1.1', '1.1', '', '  ', 42, null, '2.1'])).toEqual(['1.1', '2.1']);
  });
  it('caps the count and the id length', () => {
    expect(normalizeStepIds(Array.from({ length: 500 }, (_, i) => `s${i}`))).toHaveLength(200);
    expect(normalizeStepIds(['x'.repeat(41)])).toEqual([]);
  });
  it('returns [] for a non-array', () => {
    expect(normalizeStepIds('1.1')).toEqual([]);
    expect(normalizeStepIds(undefined)).toEqual([]);
  });
});

describe('ADR 0464 — subject erasure (this store self-polices; the host gate does NOT cover it)', () => {
  it('DELETES every row the subject owns in that tenant', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'a', completedStepIds: ['1.1'] });
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'b', completedStepIds: ['1.1'] });
    await eraseTutorialProgressForSubject(T1, ALICE);
    expect(await listTutorialProgress(T1, ALICE)).toEqual([]);
  });

  it('erases ONLY that subject — a co-member\'s rows survive (no over-erasure)', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'a', completedStepIds: ['1.1'] });
    await putTutorialProgress({ tenantId: T1, userId: BOB, tutorialId: 'a', completedStepIds: ['1.1'] });
    await eraseTutorialProgressForSubject(T1, ALICE);
    expect(await listTutorialProgress(T1, ALICE)).toEqual([]);
    expect(await listTutorialProgress(T1, BOB)).toHaveLength(1);
  });

  it('erases ONLY within the named tenant', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'a', completedStepIds: ['1.1'] });
    await putTutorialProgress({ tenantId: T2, userId: ALICE, tutorialId: 'a', completedStepIds: ['1.1'] });
    await eraseTutorialProgressForSubject(T1, ALICE);
    expect(await listTutorialProgress(T2, ALICE)).toHaveLength(1);
  });

  it('is idempotent and safe for an unknown subject (a foreign identity space is a no-op)', async () => {
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'a', completedStepIds: ['1.1'] });
    await eraseTutorialProgressForSubject(T1, 'contact:someone-else');
    expect(await listTutorialProgress(T1, ALICE)).toHaveLength(1);
    await eraseTutorialProgressForSubject(T1, ALICE);
    await eraseTutorialProgressForSubject(T1, ALICE); // twice
    expect(await listTutorialProgress(T1, ALICE)).toEqual([]);
  });

  it('the eraser is REGISTERED with the host seam (importing the store wires it)', async () => {
    // The registration is a module-scope side effect; assert it reached the host
    // registry rather than trusting that the line exists.
    const { eraseSubject } = await import('../src/host/subjectErasure.js');
    await putTutorialProgress({ tenantId: T1, userId: ALICE, tutorialId: 'a', completedStepIds: ['1.1'] });
    await eraseSubject(T1, ALICE);
    expect(await listTutorialProgress(T1, ALICE)).toEqual([]);
  });
});
