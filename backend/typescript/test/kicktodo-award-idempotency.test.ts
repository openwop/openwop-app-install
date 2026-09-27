/**
 * `PROBE-KT3`, migrated from a prose census to an executable assertion.
 *
 * The probe read: "duplicate-award probe: `GROUP BY` subject+awardId `HAVING
 * count(*)>1` (expected 0 — deterministic keys)". **Nothing drove
 * `evaluateAwards` at all** — the only test naming `awardId`
 * (`kicktodo-erasure-engagement.test.ts:22`) SEEDS two awards with distinct ids
 * to exercise erasure, and so could never have observed a duplicate.
 *
 * "Expected 0 — deterministic keys" is a claim about TWO mechanisms that a
 * single count cannot separate, so both are asserted here:
 *   1. the KEY is deterministic (`${tenant}::${subject}::${kind}::${enrollment}`),
 *      so a re-evaluation overwrites rather than appends; and
 *   2. the get-before-put guard (`engagementService.ts:187`) means a repeat
 *      evaluation reports NOTHING newly earned — the caller is told the truth,
 *      not handed a duplicate "you earned it!" event.
 *
 * (2) is the one a `GROUP BY` census is blind to: a store keyed deterministically
 * shows count=1 even if every re-evaluation re-announces the award.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { evaluateAwards, listAwards, __test } from '../src/features/kicktodo-engagement/engagementService.js';
import { type CheckIn } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-A';
const ALICE = 'user:alice';
const BOB = 'user:bob';

const checkIns = () => new DurableCollection<CheckIn>('kicktodo-checkins', (c) => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`);

async function seedCheckIn(tenantId: string, subject: string, enrollmentId: string, cardId: string): Promise<CheckIn> {
  const ci: CheckIn = { cardId, tenantId, enrollmentId, ownerSubject: subject, createdAt: '2026-01-01T09:00:00.000Z' };
  await checkIns().put(ci);
  return ci;
}

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt3-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('PROBE-KT3 (executable) — no duplicate awards per (subject, awardId)', () => {
  it('a repeat evaluation adds no row AND reports nothing newly earned', async () => {
    const ci = await seedCheckIn(T, ALICE, 'e1', 'c1');

    const first = await evaluateAwards(ci);
    // PRECONDITION: something WAS earned, else the "no duplicate" claim is vacuous.
    expect(first.length, 'no award was earned — the duplicate check below would be vacuous').toBeGreaterThan(0);
    expect(first.map((a) => a.kind)).toContain('first-check-in');
    const after1 = await listAwards(T, ALICE);
    expect(after1).toHaveLength(first.length);

    const second = await evaluateAwards(ci);

    expect(await listAwards(T, ALICE), 'a re-evaluation duplicated award rows').toHaveLength(after1.length);
    expect(second, 're-evaluation re-announced an already-earned award (a census by GROUP BY cannot see this)').toEqual([]);
  });

  it('the (subject, awardId) pair is unique — a GROUP BY … HAVING count>1 would return 0', async () => {
    await evaluateAwards(await seedCheckIn(T, ALICE, 'e1', 'c1'));
    await evaluateAwards(await seedCheckIn(T, ALICE, 'e1', 'c1'));

    const rows = (await __test.awards.list()).filter((a) => a.tenantId === T);
    expect(rows.length, 'precondition: awards exist to group over').toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (const a of rows) {
      const k = `${a.ownerSubject}::${a.awardId}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes, 'duplicate (subject, awardId) rows — the exact thing PROBE-KT3 counts').toEqual([]);
  });

  it('does not collapse two DIFFERENT subjects who earn the SAME awardId', async () => {
    // The other polarity — and it only works if the subject is the ONLY thing
    // distinguishing the two rows. My first version gave Alice and Bob different
    // enrollment ids, so their awardIds (`first-check-in::e1` vs `::e2`) already
    // differed and dropping the subject segment from the key STILL kept them
    // apart: the test passed for a reason unrelated to what it claimed to check.
    // Sharing enrollment `e1` makes the awardId identical, so the subject segment
    // is load-bearing and its removal collapses Bob onto Alice.
    await evaluateAwards(await seedCheckIn(T, ALICE, 'e1', 'c1'));
    await evaluateAwards(await seedCheckIn(T, BOB, 'e1', 'c2'));

    const alice = await listAwards(T, ALICE);
    const bob = await listAwards(T, BOB);
    expect(alice.length, 'alice lost her award').toBeGreaterThan(0);
    expect(bob.length, 'bob\'s award collapsed onto alice\'s row — the key dropped the subject').toBeGreaterThan(0);
    expect(alice[0].awardId, 'precondition: the two subjects must share an awardId for this to test anything')
      .toBe(bob[0].awardId);
  });
});
