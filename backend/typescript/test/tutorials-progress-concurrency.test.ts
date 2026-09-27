/**
 * ADR 0488 D4 — tutorial progress under CONCURRENT writers (grade-data `TUT-7`).
 *
 * The defect: a blind whole-row replace of a client-supplied list. Two devices
 * both hydrated at `{1.1}` — A completes 2.1, B completes 3.1 — and one step
 * vanished with no signal to either. The store's "deterministic key ⇒
 * idempotent" note covers duplicate ROWS, not lost UPDATES, and the existing
 * suite only asserted the former.
 *
 * These tests make the writers ACTUALLY COLLIDE rather than running them in
 * sequence and hoping — a concurrency test that never forces a race passes just
 * as happily against the broken code (a recorded lesson from the GIF-flake pass).
 * The sabotage check for this file: revert `putTutorialProgress` to a plain
 * `progress.put(...)` and the interleaved test below must go red.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  putTutorialProgress,
  listTutorialProgress,
  __clearTutorialProgressForTests,
} from '../src/features/tutorials/progressStore.js';

const T = 'tenant-tut-cas';
const ALICE = 'user:alice-hash';
const TUT = 'connect-your-ai';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  await __clearTutorialProgressForTests();
});

const stepsOf = async (): Promise<string[]> => {
  const rows = await listTutorialProgress(T, ALICE);
  return [...(rows[0]?.completedStepIds ?? [])].sort();
};

describe('concurrent progress writes never lose a completion', () => {
  it('two devices ticking DIFFERENT steps from the same base keep both', async () => {
    // Both devices hydrate at {1.1}.
    await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1'] });

    // Now they race: each sends ITS OWN full list, computed from that same base.
    // Issued together so the second genuinely swaps against a row the first moved.
    const [a, b] = await Promise.all([
      putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1', '2.1'] }),
      putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1', '3.1'] }),
    ]);

    // The whole point: NEITHER completion is dropped.
    expect(await stepsOf()).toEqual(['1.1', '2.1', '3.1']);
    // Exactly one of them had to merge, and it is told so — a client that is
    // not told cannot re-sync and drifts silently.
    expect([a.merged, b.merged].filter(Boolean).length).toBe(1);
    const mergedResult = a.merged ? a : b;
    expect([...mergedResult.completedStepIds].sort()).toEqual(['1.1', '2.1', '3.1']);
  });

  it('many simultaneous writers all survive', async () => {
    const writes = ['1.1', '2.1', '3.1', '4.1', '5.1'].map((s) =>
      putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: [s] }));
    await Promise.all(writes);
    expect(await stepsOf()).toEqual(['1.1', '2.1', '3.1', '4.1', '5.1']);
  });

  it('UNCHECKING still works when there is no contention (union must not win here)', async () => {
    await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1', '2.1'] });
    // A plain union-merge would make this impossible — that is why the write is
    // a CAS'd replace and only FALLS BACK to union on a real conflict.
    const r = await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1'] });
    expect(r.merged).toBe(false);
    expect(await stepsOf()).toEqual(['1.1']);
  });

  it('RESET clears, and is never unioned back', async () => {
    await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1', '2.1'] });
    const r = await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: [], mode: 'clear' });
    expect(r.completedStepIds).toEqual([]);
    expect(await stepsOf()).toEqual([]);
  });

  it('a first write on a fresh row still lands (CAS against null)', async () => {
    const r = await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1'] });
    expect(r.merged).toBe(false);
    expect(await stepsOf()).toEqual(['1.1']);
  });

  it('normalization still applies to a merged result (bounds are not bypassed)', async () => {
    await putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1'] });
    await Promise.all([
      putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1', '2.1'] }),
      // A junk id must not slip in via the union path.
      putTutorialProgress({ tenantId: T, userId: ALICE, tutorialId: TUT, completedStepIds: ['1.1', 'x'.repeat(200)] }),
    ]);
    const steps = await stepsOf();
    expect(steps).toContain('1.1');
    expect(steps.some((s) => s.length > 40)).toBe(false);
  });
});
