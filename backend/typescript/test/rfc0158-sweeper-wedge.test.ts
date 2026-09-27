/**
 * RFC 0158 §B.5 — a hung outbox pass must not silently disable orphan recovery.
 *
 * §B.5: "The recovery bound MUST be derived from the mechanism that enforces it
 * ... A declared bound that no mechanism produces is a claim, not a bound." A
 * sweeper that can stop running without saying so does not produce the bound the
 * host declares — the number stays true on paper and false in production.
 *
 * THE DEFECT. `startRunDispatchSweeper` guards re-entry with `if (running)
 * return;`, sets `running = true`, and released it in a `finally` attached to
 * the SECOND of two sequential try blocks. Each lane was individually caught, so
 * a lane that THREW could not stop the other — that part worked and its docblock
 * said so. But a lane that HANGS never settles, never throws, and never reaches
 * the second try, so `running` stays true and EVERY later tick returns
 * immediately. Both lanes stop. No error is logged, because nothing failed.
 *
 * That state is indistinguishable from a healthy idle daemon from the outside,
 * which is why it needs a test rather than review. This host has shipped the
 * identical shape before: #3056 left `shellRefreshing` set after a
 * fire-and-forget refresh never resumed under Cloud Run CPU throttling, and `/`
 * served a stale bundle for 16+ minutes with ZERO errors in the logs.
 *
 * WHAT THIS TEST DOES NOT CLAIM. It does not claim this caused any particular
 * missed recovery. It reproduces the shape and pins the fix. A durability
 * exercise on 2026-08-19 failed to reclaim a run whose lease had been expired
 * for ~4 minutes across ~8 orphan passes, with no errors logged — consistent
 * with a wedge and not proof of one, since the daemon was also observed
 * reclaiming a pre-expired orphan within 24s of boot. Recorded honestly rather
 * than resolved by assertion.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { startRunDispatchSweeper, POLL_INTERVAL_MS, ORPHAN_SWEEP_EVERY_N_TICKS, WEDGE_TICKS } from '../src/host/runDispatchSweeper.js';
import type { RunSweeperDeps } from '../src/host/runDispatchSweeper.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Deps whose OUTBOX pass hangs forever and whose orphan claim is observable. */
function wedgingDeps(): { deps: RunSweeperDeps; orphanClaims: () => number; releaseOutbox: () => void } {
  let claims = 0;
  let release: () => void = () => {};
  const storage = {
    // The outbox lane's first storage call never settles — a hang, not a throw.
    async claimDispatchOutbox() {
      await new Promise<void>((r) => { release = r; });
      return [];
    },
    async claimOrphanedRuns() { claims += 1; return []; },
  } as unknown as RunSweeperDeps['storage'];
  return {
    deps: { storage, hostSuite: {} as RunSweeperDeps['hostSuite'] },
    orphanClaims: () => claims,
    releaseOutbox: () => release(),
  };
}

describe('RFC 0158 §B.5 — the sweeper cannot be silently disabled by one hung pass', () => {
  it('runs the orphan lane even while an outbox pass is hung', async () => {
    vi.useFakeTimers();
    const { deps, orphanClaims } = wedgingDeps();
    const sweeper = startRunDispatchSweeper(deps, 'wedge-worker');

    // Run well past several orphan cadences. Pre-fix, tick 1 hangs, `running`
    // stays true, and every subsequent tick returns at the guard — so the orphan
    // lane is reached ZERO times no matter how long this advances.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS * 4);

    expect(
      orphanClaims(),
      'a hung OUTBOX pass must not stop the ORPHAN lane — recovery is what the declared bound rests on',
    ).toBeGreaterThan(0);
    sweeper.stop();
  });

  it('RECOVERS the hung lane itself — a bounded pass, not merely an isolated one', async () => {
    // Decoupling the guards keeps a hung outbox from killing orphan recovery,
    // but it does NOT revive the outbox lane: its own guard stays set forever
    // and that lane is dead. The per-lane deadline is what turns the hang into a
    // caught error so the lane runs again.
    //
    // This leg exists because sabotage found the previous version could not see
    // it: deleting `withDeadline` entirely left the other leg green, i.e. the
    // deadline was shipped untested. A mechanism no test covers is the thing
    // this whole RFC is about.
    vi.useFakeTimers();
    let outboxAttempts = 0;
    const storage = {
      async claimDispatchOutbox() {
        outboxAttempts += 1;
        await new Promise<void>(() => { /* never settles */ });
        return [];
      },
      async claimOrphanedRuns() { return []; },
    } as unknown as RunSweeperDeps['storage'];
    const sweeper = startRunDispatchSweeper(
      { storage, hostSuite: {} as RunSweeperDeps['hostSuite'] },
      'wedge-worker-2',
    );

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * WEDGE_TICKS * 3);

    expect(
      outboxAttempts,
      'the outbox lane must be retried after its deadline abandons a hung pass — otherwise that lane is permanently dead',
    ).toBeGreaterThan(1);
    sweeper.stop();
  });
});
