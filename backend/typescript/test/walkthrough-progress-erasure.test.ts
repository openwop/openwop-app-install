/**
 * ADR 0464 — `walkthrough-progress` subject erasure.
 *
 * This store carried a `userId` and had NO eraser at all, while its own header
 * claimed the residue was "all reclaimed by account erasure" — true for TENANT
 * deletion, false for the per-subject DSAR case ADR 0464 exists for. The ADR's
 * coverage ratchet could not catch it because that gate enumerates only
 * `src/host/**`; the companion `subject-erasure-feature-stores.test.ts` closes
 * that blind spot structurally, and this file proves the eraser actually ERASES
 * rather than merely being registered.
 *
 * The interesting case is the LEGACY row: `tenantId:walkthroughId` (no userId)
 * is shared tenant state by construction, so erasing one member's subject MUST
 * NOT delete it — that would silently destroy another member's resume state.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  listWalkthroughProgress,
  putWalkthroughProgress,
  eraseWalkthroughProgressForSubject,
  __clearWalkthroughProgressForTests,
} from '../src/features/walkthroughs/progressStore.js';

const T1 = 'tenant-wt-erase-1';
const T2 = 'tenant-wt-erase-2';
const ALICE = 'user:alice-hash';
const BOB = 'user:bob-hash';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  await __clearWalkthroughProgressForTests();
});

const row = (tenantId: string, walkthroughId: string, userId?: string) => ({
  tenantId,
  ...(userId ? { userId } : {}),
  walkthroughId,
  status: 'started' as const,
  runId: `run-${walkthroughId}`,
  updatedAt: '2026-07-27T00:00:00.000Z',
});

describe('eraseWalkthroughProgressForSubject', () => {
  it('deletes the subject\'s own rows', async () => {
    await putWalkthroughProgress(row(T1, 'wt-a', ALICE));
    await putWalkthroughProgress(row(T1, 'wt-b', ALICE));
    expect((await listWalkthroughProgress(T1, ALICE)).length).toBe(2); // non-vacuous

    await eraseWalkthroughProgressForSubject(T1, ALICE);
    expect(await listWalkthroughProgress(T1, ALICE)).toEqual([]);
  });

  it('does NOT touch another member\'s rows', async () => {
    await putWalkthroughProgress(row(T1, 'wt-a', ALICE));
    await putWalkthroughProgress(row(T1, 'wt-a', BOB));

    await eraseWalkthroughProgressForSubject(T1, ALICE);
    expect((await listWalkthroughProgress(T1, BOB)).map((r) => r.walkthroughId)).toEqual(['wt-a']);
  });

  it('does NOT touch the same subject in another tenant', async () => {
    await putWalkthroughProgress(row(T1, 'wt-a', ALICE));
    await putWalkthroughProgress(row(T2, 'wt-a', ALICE));

    await eraseWalkthroughProgressForSubject(T1, ALICE);
    expect((await listWalkthroughProgress(T2, ALICE)).map((r) => r.walkthroughId)).toEqual(['wt-a']);
  });

  it('LEAVES the legacy tenant-level row — it is shared state, not this subject\'s', async () => {
    await putWalkthroughProgress(row(T1, 'wt-legacy')); // no userId ⇒ legacy key
    await putWalkthroughProgress(row(T1, 'wt-a', ALICE));

    await eraseWalkthroughProgressForSubject(T1, ALICE);
    // Read as an anonymous caller: legacy rows only.
    expect((await listWalkthroughProgress(T1)).map((r) => r.walkthroughId)).toEqual(['wt-legacy']);
  });

  it('is idempotent (a re-run erases nothing further and does not throw)', async () => {
    await putWalkthroughProgress(row(T1, 'wt-a', ALICE));
    await eraseWalkthroughProgressForSubject(T1, ALICE);
    await expect(eraseWalkthroughProgressForSubject(T1, ALICE)).resolves.toBeUndefined();
    expect(await listWalkthroughProgress(T1, ALICE)).toEqual([]);
  });

  it('the eraser is REGISTERED with the host seam (importing the store wires it)', async () => {
    const { eraseSubject } = await import('../src/host/subjectErasure.js');
    await putWalkthroughProgress(row(T1, 'wt-a', ALICE));
    await eraseSubject(T1, ALICE);
    expect(await listWalkthroughProgress(T1, ALICE)).toEqual([]);
  });

  it('a subject whose key PREFIXES another is not over-erased', async () => {
    // Keys are `tenant:subject:walkthrough`; the prefix scan must not let
    // `user:abc` claim `user:abcd`'s rows.
    await putWalkthroughProgress(row(T1, 'wt-a', 'user:abc'));
    await putWalkthroughProgress(row(T1, 'wt-a', 'user:abcd'));

    await eraseWalkthroughProgressForSubject(T1, 'user:abc');
    expect((await listWalkthroughProgress(T1, 'user:abcd')).map((r) => r.walkthroughId)).toEqual(['wt-a']);
  });
});
