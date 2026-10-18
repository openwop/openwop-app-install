/**
 * KTENR-2 / KTX-D2 (KickTodo wave 4C) — the explicit backfill for the subject
 * fields an anon→user tenant fold does not rewrite (`foldSubjectBackfill.ts`).
 *
 * The fold rewrites tenant segments only, so an enrollment made in an `anon:`
 * sandbox arrives still owned by the anon subject: the user's own lists miss it.
 * The repair is DORMANT by decision — real only if an anonymous principal can
 * enrol (PROBE-7, not yet run) — so the load-bearing properties are:
 *  1. it changes ZERO rows when nothing is mismatched (byte-compared below);
 *  2. nothing in the app calls it (no boot / scheduled / route invocation);
 *  3. when it IS called with a real mismatch it re-owns the enrollment and its
 *     check-ins, refuses a conflicting one, and a second run is a no-op.
 *
 * What breaks these (sabotage-witnessed, each reverted and restored):
 *  - drop the `e.ownerSubject !== fromSubject` filter → the zero-change case
 *    rewrites other people's enrollments;
 *  - call `backfillFoldedEnrollmentSubjects` from any src module → the
 *    no-invocation pin reds;
 *  - drop the `held` conflict check → the conflict case re-owns a duplicate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, listEnrollmentsFor, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { backfillFoldedEnrollmentSubjects } from '../src/features/kicktodo-core/foldSubjectBackfill.js';
import type { CheckIn } from '../src/features/kicktodo-core/types.js';

const T = 'user:fold-tenant';
const ANON = 'anon:fold-sandbox-subject';
const USER = 'user:fold-real-subject';
const OTHER = 'user:fold-bystander';
const checkIns = () => new DurableCollection<CheckIn>('kicktodo-checkins', (c) => `${c.tenantId}::${c.enrollmentId}::${c.cardId}`);

let storage: Storage;
let challengeId = '';
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Fold', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
});

const snapshot = async () => JSON.stringify((await storage.kvList('')).map((r) => [r.key, r.value]));

describe('KTENR-2 — the fold-subject backfill', () => {
  it('changes ZERO rows when nothing is mismatched (byte-identical store)', async () => {
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: OTHER, challengeId, challengeVersion: 1, timezone: 'UTC' });
    await checkIns().put({ cardId: 'card-1', tenantId: T, enrollmentId: enrollment.id, ownerSubject: OTHER, createdAt: '2026-01-01T00:00:00.000Z' });
    const before = await snapshot();
    const res = await backfillFoldedEnrollmentSubjects({ tenantId: T, fromSubject: ANON, toSubject: USER });
    expect(res).toEqual({ enrollments: 0, checkIns: 0, conflicts: [], raced: [] });
    expect(await snapshot()).toBe(before);
  });

  it('dry-run reports a real mismatch and writes nothing', async () => {
    await enroll({ tenantId: T, ownerSubject: ANON, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const before = await snapshot();
    expect(await backfillFoldedEnrollmentSubjects({ tenantId: T, fromSubject: ANON, toSubject: USER, dryRun: true }))
      .toMatchObject({ enrollments: 1 });
    expect(await snapshot()).toBe(before);
  });

  it('re-owns a folded enrollment + its check-ins, and a second run is a no-op', async () => {
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: ANON, challengeId, challengeVersion: 1, timezone: 'UTC' });
    await checkIns().put({ cardId: 'card-1', tenantId: T, enrollmentId: enrollment.id, ownerSubject: ANON, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await listEnrollmentsFor(T, USER)).toEqual([]); // the gap: the user cannot see it

    expect(await backfillFoldedEnrollmentSubjects({ tenantId: T, fromSubject: ANON, toSubject: USER }))
      .toEqual({ enrollments: 1, checkIns: 1, conflicts: [], raced: [] });
    expect((await listEnrollmentsFor(T, USER)).map((e) => e.id)).toEqual([enrollment.id]); // same enr: id
    expect((await checkIns().get(`${T}::${enrollment.id}::card-1`))?.ownerSubject).toBe(USER);

    const before = await snapshot();
    expect(await backfillFoldedEnrollmentSubjects({ tenantId: T, fromSubject: ANON, toSubject: USER }))
      .toEqual({ enrollments: 0, checkIns: 0, conflicts: [], raced: [] });
    expect(await snapshot()).toBe(before);
  });

  it('refuses to give one person two enrollments in one version (reported as a conflict)', async () => {
    const { enrollment: folded } = await enroll({ tenantId: T, ownerSubject: ANON, challengeId, challengeVersion: 1, timezone: 'UTC' });
    await enroll({ tenantId: T, ownerSubject: USER, challengeId, challengeVersion: 1, timezone: 'UTC' });
    expect(await backfillFoldedEnrollmentSubjects({ tenantId: T, fromSubject: ANON, toSubject: USER }))
      .toEqual({ enrollments: 0, checkIns: 0, conflicts: [folded.id], raced: [] });
    expect((await listEnrollmentsFor(T, ANON)).map((e) => e.id)).toEqual([folded.id]);
  });

  it('is never invoked by the app: no src module calls it (explicit-only, by decision)', () => {
    const SRC = join(__dirname, '..', 'src');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    const callers = walk(SRC)
      .filter((f) => !f.endsWith('foldSubjectBackfill.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('backfillFoldedEnrollmentSubjects'));
    expect(callers).toEqual([]);
  });
});
