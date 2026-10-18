/**
 * KickTodo wave 4B (slice A) — invite + enrol races in kicktodo-core.
 *
 *  - KTCORE-3: two concurrent `mintInvite` calls by ONE inviter. `lockstep()`
 *    holds both racers' read of the one-live index row until both have read it,
 *    so both provably see the SAME prior before either writes. The invariant:
 *    at most ONE of the returned tokens resolves, and it is the one the index
 *    names. Breaks if the index write goes back to a blind `put` (both tokens
 *    stay live — the loser's untracked by the index): MEASURED red on the
 *    pre-fix `mintInvite` ("expected 2 to have a length of 1"). Under THIS
 *    interleaving either half of the fix alone (the index CAS, or the
 *    post-write re-check) keeps it green; the re-check exists for the other
 *    order (a later mint revoking our hash before our row is written).
 *  - KTCORE-2: retiring the only published version revokes the live link, and a
 *    token whose row was never revoked still stops resolving once no version is
 *    published. Breaks if `resolveInvite` drops its `hasPublishedVersion` check
 *    (second case) or `retireOne` drops its revoke (first case asserts the row).
 *  - KTC-10: the enrol create-CAS loses with NO winner row. Breaks if `enroll`
 *    falls through again: it would return an enrollment that was never stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge, retireChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, __clearEnrollGuards, EnrollConflictError } from '../src/features/kicktodo-core/enrollmentService.js';
import { enrollmentId as deriveEnrollmentId } from '../src/features/kicktodo-core/types.js';
import { mintInvite, resolveInvite } from '../src/features/kicktodo-core/inviteService.js';

const T = 'tenant-kt4b-core';
const INVITER = 'user:kt4b-inviter';

let storage: Storage;
let restore: Array<() => void> = [];

/** Hold the first `racers` reads of ONE storage key until all have arrived
 *  (2 s fallback so a broken hold fails the arrivals assert instead of hanging). */
function lockstep(key: string, racers: number): { arrivals: () => number } {
  const original = storage.kvGet.bind(storage);
  let arrivals = 0;
  let batch: Array<() => void> = [];
  const release = (): void => { const b = batch; batch = []; for (const f of b) f(); };
  const spy = vi.spyOn(storage, 'kvGet').mockImplementation(async (k: string) => {
    if (k === key && arrivals < racers) {
      arrivals += 1;
      await new Promise<void>((r) => {
        batch.push(r);
        if (batch.length === racers) release();
        else if (batch.length === 1) setTimeout(release, 2000);
      });
    }
    return original(k);
  });
  restore.push(() => spy.mockRestore());
  return { arrivals: () => arrivals };
}

async function publishedChallenge(): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Race', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
});
afterEach(() => {
  for (const f of restore) f();
  restore = [];
});

describe('KTCORE-3 — concurrent re-mints leave exactly one live link', () => {
  it('two mints that read the same prior: only the token the index names resolves', async () => {
    const challengeId = await publishedChallenge();
    const first = await mintInvite(T, challengeId, INVITER); // a prior to revoke

    const race = lockstep(`hostext:kicktodo-invite-index:${T}::${challengeId}::${INVITER}`, 2);
    const [a, b] = await Promise.all([mintInvite(T, challengeId, INVITER), mintInvite(T, challengeId, INVITER)]);
    expect(race.arrivals(), 'the race was not forced — both mints must read the index before either writes').toBe(2);

    const live = [];
    for (const tok of [first, a, b]) if (await resolveInvite(T, tok)) live.push(tok);
    expect(live).toHaveLength(1); // ONE live link per (inviter, challenge)
    expect([a, b]).toContain(live[0]);
  });
});

describe('KTCORE-2 — a retired challenge kills its invite links', () => {
  it('retiring the only published version revokes the live token row', async () => {
    const challengeId = await publishedChallenge();
    const tok = await mintInvite(T, challengeId, INVITER);
    await retireChallenge(T, challengeId, 1);
    expect(await resolveInvite(T, tok)).toBeNull();
    // The ROW is revoked, not merely filtered at read: re-publishing a new
    // version must not resurrect a link the retire killed.
    const raw = await storage.kvList('hostext:kicktodo-invites:');
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!.value).revokedAt).toEqual(expect.any(String));
  });

  it('a never-revoked token stops resolving once no version is published', async () => {
    const challengeId = await publishedChallenge();
    const tok = await mintInvite(T, challengeId, INVITER);
    // Simulate a token whose retire-time revoke was missed: un-revoke the row by hand.
    await retireChallenge(T, challengeId, 1);
    const [row] = await storage.kvList('hostext:kicktodo-invites:');
    const parsed = JSON.parse(row!.value) as Record<string, unknown>;
    delete parsed.revokedAt;
    await storage.kvSet(row!.key, JSON.stringify(parsed));
    expect(await resolveInvite(T, tok)).toBeNull();
  });
});

describe('KTC-10 — a lost enrol CAS with no winner is a typed failure', () => {
  it('throws EnrollConflictError and returns no phantom enrollment', async () => {
    const challengeId = await publishedChallenge();
    const id = deriveEnrollmentId(T, 'user:kt4b-joiner', challengeId, 1);
    const enrollKey = `hostext:kicktodo-enrollments:${T}::${id}`;
    // The CAS loses (a row existed) and the row is gone by the re-read: report a
    // lost swap without writing anything.
    const original = storage.kvCompareAndSwap.bind(storage);
    let forced = 0;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (k, exp, next) => {
      if (k === enrollKey && exp === null && forced === 0) { forced += 1; return { swapped: false } as Awaited<ReturnType<Storage['kvCompareAndSwap']>>; }
      return original(k, exp, next);
    });
    restore.push(() => spy.mockRestore());

    await expect(enroll({ tenantId: T, ownerSubject: 'user:kt4b-joiner', challengeId, challengeVersion: 1, timezone: 'UTC' }))
      .rejects.toBeInstanceOf(EnrollConflictError);
    expect(forced).toBe(1);
    expect(await getEnrollment(T, id)).toBeNull();
  });
});
