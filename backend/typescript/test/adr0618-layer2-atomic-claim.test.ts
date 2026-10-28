/**
 * ADR 0618 — the Layer-2 effect guard is an ATOMIC CLAIM, not a read-then-write.
 *
 * `spec/v1/idempotency.md` §"Concurrent duplicates (Layer 2)" (Stable, v1.7):
 *
 *   > the persist that guards the effect **MUST** be an atomic claim: exactly
 *   > one executor wins the compare-and-set / insert-if-absent and fires, and
 *   > the other observes the hit … A non-atomic read-then-write does **NOT**
 *   > satisfy the exactly-once guarantee under concurrent delivery … and it
 *   > **MUST** hold within a single-instance deployment.
 *
 * Unconditional: no capability gate, and `sideEffectSuppression: none` is an
 * assurance advertisement rather than a gate on the obligation.
 *
 * WHAT WAS THERE BEFORE. `putInvocation` is `INSERT OR REPLACE` keyed
 * `(run, node, attempt, providerKey)` — it always wins, so it can never report
 * the conflict a claim exists to report, and its key carries `attempt`, so two
 * attempts at one identity mint two rows. The emitter's own docblock had already
 * named the fix it lacked: *"a real CAS claim (an `ON CONFLICT DO NOTHING`
 * insert used as a lock), not a longer read."*
 *
 * Tracker TST-BG3-14. Red when: the sqlite claim's conflict arm takes over a FRESH
 * claim (`WHERE 1 = 1`), loses the stale takeover (`DO NOTHING`), measures staleness
 * from `nowMs` instead of `nowMs - staleAfterMs`, the release DELETE matches nothing,
 * or `emitNotification` fires after LOSING the claim (`if (!won)` skipped). The
 * claim key's lack of `attempt` is pinned at COMPILE time (`@ts-expect-error`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { setEffectEscapeBackend, mintEffectIdentity } from '../src/host/effectEscapeLedger.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { resetLogicalInvocationOrdinals } from '../src/host/effectIdentity.js';
import { getNotificationEmitter, setNotificationBackend } from '../src/notifications/emitter.js';

let storage: Storage;
const KEY = { runId: 'r1', nodeId: 'n1', invocationId: 'inv-1' };
const FRESH = { nowMs: 1_000_000, staleAfterMs: 600_000 };

beforeEach(async () => {
  storage = await openStorage('memory://');
});

describe('ADR 0618 — claimInvocation is an atomic claim', () => {
  it('the first caller wins', async () => {
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);
  });

  // THE LOAD-BEARING ONE. This is the assertion the old shape could not make:
  // `putInvocation` would have returned void for both callers.
  it('a second caller at the SAME identity loses', async () => {
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(false);
  });

  // The concurrency witness. `Promise.all` on one better-sqlite3 connection is
  // not true parallelism, but it does interleave at every await point, which is
  // exactly where a read-then-write loses — and the assertion is on the COUNT of
  // winners, which is the spec's own phrasing ("exactly one executor wins").
  it('under N concurrent contenders, EXACTLY ONE wins', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => storage.claimInvocation(KEY, FRESH)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  // POSITIVE CONTROL. Without this, a claim that refused EVERYTHING would pass
  // every assertion above except the first.
  it('positive control — a DIFFERENT identity is not blocked by an existing claim', async () => {
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);
    expect(await storage.claimInvocation({ ...KEY, invocationId: 'inv-2' }, FRESH)).toBe(true);
    expect(await storage.claimInvocation({ ...KEY, nodeId: 'n2' }, FRESH)).toBe(true);
    expect(await storage.claimInvocation({ ...KEY, runId: 'r2' }, FRESH)).toBe(true);
  });

  // The identity is retry-stable: `attempt` is deliberately NOT part of the key,
  // because RFC 0150 §B retired the attempt-bearing composition as a safety fix.
  // A second ATTEMPT at one identity must not be able to re-fire the effect.
  it('the claim key excludes `attempt` — a retry cannot mint a fresh claim', async () => {
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);
    // The SIGNATURE has no attempt: tsc refuses the extra property (the directive
    // below goes red the moment `attempt` joins the key), and at run time a second
    // ATTEMPT at the same identity still loses the claim.
    // @ts-expect-error — `attempt` is not part of the claim key (RFC 0150 §B).
    expect(await storage.claimInvocation({ runId: 'r1', nodeId: 'n1', invocationId: 'inv-1', attempt: 2 }, FRESH)).toBe(false);
  });
});

describe('ADR 0618 — a stale claim is taken over, so a dead winner cannot strand the effect', () => {
  // Without takeover, a pure insert-if-absent converts a DUPLICATE into a LOST
  // effect: the winner dies between claiming and firing, the row stays forever,
  // and every later executor declines. Layer 1 already answers this ("atomic
  // reclaim of an expired pending owner", v1.5); Layer 2 takes the same shape.
  it('a claim older than staleAfterMs may be taken over — by exactly one contender', async () => {
    expect(await storage.claimInvocation(KEY, { nowMs: 1_000_000, staleAfterMs: 600_000 })).toBe(true);

    const later = { nowMs: 1_000_000 + 600_001, staleAfterMs: 600_000 };
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () => storage.claimInvocation(KEY, later)),
    );
    expect(contenders.filter(Boolean)).toHaveLength(1);
  });

  it('a claim INSIDE the window is NOT taken over', async () => {
    expect(await storage.claimInvocation(KEY, { nowMs: 1_000_000, staleAfterMs: 600_000 })).toBe(true);
    const justBefore = { nowMs: 1_000_000 + 599_999, staleAfterMs: 600_000 };
    expect(await storage.claimInvocation(KEY, justBefore)).toBe(false);
  });

  it('releasing a claim lets the next contender win immediately', async () => {
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(false);
    await storage.releaseInvocationClaim(KEY);
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);
  });
});

describe('ADR 0618 — the claim is a SEPARATE concern from the result memo', () => {
  // The memo cannot be the claim, and this pins why rather than asserting it:
  // `putInvocation` is an upsert, so it reports nothing and is keyed on attempt.
  it('putInvocation still overwrites and still reports nothing — it is not a claim', async () => {
    const memoKey = { ...KEY, attempt: 0 };
    await storage.putInvocation(memoKey, { v: 1 });
    // Second write at the SAME key succeeds and replaces. A claim would refuse.
    await expect(storage.putInvocation(memoKey, { v: 2 })).resolves.toBeUndefined();
    expect(await storage.getInvocation(memoKey)).toEqual({ v: 2 });
  });

  it('a claim does not create a memo, and a memo does not create a claim', async () => {
    await storage.putInvocation({ ...KEY, attempt: 0 }, { v: 1 });
    // The memo exists; the claim is still free.
    expect(await storage.claimInvocation(KEY, FRESH)).toBe(true);

    await storage.releaseInvocationClaim(KEY);
    await storage.claimInvocation({ ...KEY, invocationId: 'inv-9' }, FRESH);
    // The claim exists; no memo was written for it.
    expect(await storage.getLatestInvocation({ ...KEY, invocationId: 'inv-9' })).toBeNull();
  });
});

/**
 * The seam half. A claim primitive nobody consults changes nothing, so this
 * drives `emitNotification` itself and asserts on the DELIVERED count.
 *
 * THE FIRST VERSION OF THIS TEST DID NOT WITNESS THE CLAIM. It emitted twice
 * SEQUENTIALLY and asserted one notification — which passes with the claim
 * bypassed, because the pre-existing ADR 0591 memo suppresses the second emit on
 * its own. MEASURED: stubbing the claim to always win left it green.
 *
 * The claim only matters when BOTH executors miss the memo, i.e. when the second
 * arrives before the first has written one. So the loser's condition is staged
 * directly: pre-claim the identity the emit is about to mint, then emit. No memo
 * exists, the claim is held by "the other executor", and the seam must decline.
 */
describe('ADR 0618 — the notification seam declines to fire when it loses the claim', () => {
  const INPUT = {
    tenantId: 't1',
    recipientUserId: 'u1',
    type: 'approval.needed',
    priority: 'normal' as const,
    title: 'Approve the thing',
    message: 'Please approve.',
  };
  const CTX = { runId: 'run-0616', replaying: false, nodeId: 'notify', tenantId: 't1', attempt: 1 };

  async function host(): Promise<{ st: Storage; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'adr0616-'));
    const st = await openStorage(`sqlite://${join(dir, 'c.db')}`);
    setNotificationBackend(st);
    setEffectEscapeBackend(st);
    setInvocationBackend(st);
    return { st, dir };
  }

  it('LOSER: with the identity already claimed and NO memo, nothing is inserted', async () => {
    const { st, dir } = await host();

    // Mint exactly what the emit will mint, then hold it as the other executor.
    resetLogicalInvocationOrdinals();
    const identity = await runWithEffectContext(CTX, async () =>
      mintEffectIdentity('notification:approval.needed'),
    );
    expect(identity, 'the identity must mint, or this test proves nothing').not.toBeNull();
    expect(
      await st.claimInvocation(
        { runId: identity!.runId, nodeId: identity!.nodeId, invocationId: identity!.invocationId },
        { nowMs: Date.now(), staleAfterMs: 600_000 },
      ),
    ).toBe(true);

    resetLogicalInvocationOrdinals();
    await runWithEffectContext(CTX, async () => {
      await getNotificationEmitter().emit({ ...INPUT });
    });

    const listed = await st.listNotifications({ tenantId: 't1', recipientUserId: 'u1' });
    expect(listed.length, 'the loser must not notify a second person').toBe(0);
    await st.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('WINNER positive control — with the claim FREE, the same emit does insert', async () => {
    const { st, dir } = await host();

    resetLogicalInvocationOrdinals();
    await runWithEffectContext(CTX, async () => {
      await getNotificationEmitter().emit({ ...INPUT });
    });

    const listed = await st.listNotifications({ tenantId: 't1', recipientUserId: 'u1' });
    expect(listed.length, 'without a competing claim the emit must fire').toBe(1);
    await st.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * THE RACE ITSELF — corpus gap G17's missing witness.
 *
 * The suite above stages the loser's CONDITION (pre-claim the identity, then
 * emit). That is deterministic and it is not the race. openwop-1 named the
 * check this file was missing:
 *
 *   > two executors driven concurrently against one seam with the claim reverted
 *   > to `INSERT OR REPLACE` — if that does not produce a duplicate, the harness
 *   > is not reproducing the race and a green result would mean nothing.
 *
 * MEASURED, both directions, and this is the whole point of the test:
 *   pre-ADR-0618 (no claim, memo read-then-write only) -> delivered = 2
 *   with the claim                                     -> delivered = 1
 *
 * So the duplicate is REAL and reproducible here, not theoretical. A green on
 * this test means the claim suppressed a duplicate that the same harness
 * demonstrably produces without it.
 *
 * HOW TWO EXECUTORS GET THE SAME IDENTITY IN ONE PROCESS. The emitter's own
 * docblock notes that a second emit normally mints a DIFFERENT identity, because
 * the ordinal counter is module-level and monotonic — which is why this was
 * "not reproducible single-instance" and stayed unwitnessed. The reset between
 * two UN-AWAITED calls models what a real re-dispatch does: each executor
 * re-executes the node from the start, so each begins its ordinal sequence at 0.
 * `mintEffectIdentity` runs synchronously before the first await inside `emit`,
 * so both calls mint before either yields, and both mint ordinal 0.
 */
describe('ADR 0618 — the race, driven concurrently (G17 witness)', () => {
  it('two concurrent executors at one identity deliver EXACTLY ONE notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adr0618-race-'));
    const st = await openStorage(`sqlite://${join(dir, 'race.db')}`);
    setNotificationBackend(st);
    setEffectEscapeBackend(st);
    setInvocationBackend(st);

    const ctx = { runId: 'run-race', replaying: false, nodeId: 'notify', tenantId: 't1', attempt: 1 };
    const input = {
      tenantId: 't1',
      recipientUserId: 'u1',
      type: 'approval.needed',
      priority: 'normal' as const,
      title: 'Approve the thing',
      message: 'Please approve.',
    };

    resetLogicalInvocationOrdinals();
    const a = runWithEffectContext(ctx, async () => getNotificationEmitter().emit({ ...input }));
    resetLogicalInvocationOrdinals();
    const b = runWithEffectContext(ctx, async () => getNotificationEmitter().emit({ ...input }));
    await Promise.allSettled([a, b]);

    const listed = await st.listNotifications({ tenantId: 't1', recipientUserId: 'u1' });
    expect(
      listed.length,
      'the same harness delivers 2 without the claim — see the docblock',
    ).toBe(1);
    await st.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
