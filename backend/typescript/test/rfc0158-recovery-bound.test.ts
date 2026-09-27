/**
 * RFC 0158 §B — the declared recovery bound is DERIVED, not stated.
 *
 * §B.5: "The recovery bound MUST be derived from the mechanism that enforces it,
 * not stated independently of it. A declared bound that no mechanism produces is
 * a claim, not a bound."
 *
 * THE SHAPE OF THIS FILE IS DICTATED BY THAT SENTENCE. The obvious test —
 * `expect(declaredRecoveryBoundMs()).toBe(750_000)` — is the one thing that must
 * NOT be written here. It would pass while any of the three underlying constants
 * drifted, leaving a declared bound no mechanism produces: exactly the defect
 * §B.5 names, wearing a green test as cover. This repo has shipped that shape
 * before under the name "advert derived from the constant, not a literal"
 * (ADR 0556 H97).
 *
 * So the assertions here are RELATIONS between the bound and the constants that
 * cause it. Every one of them survives a deliberate change to a constant and
 * fails if the derivation is bypassed.
 */

import { describe, expect, it } from 'vitest';
import { RUN_DISPATCH_LEASE_MS, RUN_DURATION_CEILING_MS } from '../src/executor/executor.js';
import {
  GRACE_MS,
  OUTBOX_LEASE_MS,
  POLL_INTERVAL_MS,
  ORPHAN_SWEEP_EVERY_N_TICKS,
} from '../src/host/runDispatchSweeper.js';
import { recoveryBoundTerms, declaredRecoveryBoundMs } from '../src/host/recoveryBound.js';

describe('RFC 0158 §B.5 — the bound is derived from the mechanism', () => {
  it('the orphan cadence is the PRODUCT, not the poll interval', () => {
    // Reading POLL_INTERVAL_MS alone understates the wait 6x. The orphan lane
    // runs every Nth tick; a bound built on the tick rate would be a bound the
    // sweeper never honours.
    expect(recoveryBoundTerms().orphanSweepIntervalMs).toBe(
      POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS,
    );
  });

  it('the unleased case derives from the OUTBOX lane, which is what enforces it', () => {
    // Was `GRACE_MS + orphanSweep` (150s) until 2026-08-25 — derived from the
    // orphan lane, which never reaches an unleased run: the outbox due-query has
    // no creation-grace window, the outbox row is not discharged at dispatch, and
    // the outbox lane runs every tick rather than every sixth. 150s BOUNDED
    // reality while being produced by a lane that never touches this work, which
    // is the §B.5 failure exactly.
    expect(recoveryBoundTerms().unleasedMs).toBe(OUTBOX_LEASE_MS + POLL_INTERVAL_MS);
  });

  it('the unleased bound does NOT depend on the orphan lane at all', () => {
    // The regression guard for the defect above. If someone re-derives unleased
    // from GRACE_MS or the orphan cadence, these stop holding — and both are
    // stated as inequalities against the orphan constants rather than as a
    // pinned number, so the check survives a change to the outbox constants.
    const t = recoveryBoundTerms();
    expect(t.unleasedMs).toBeLessThan(GRACE_MS);
    expect(t.unleasedMs).toBeLessThan(t.orphanSweepIntervalMs + GRACE_MS);
  });

  it('the leased case is a full dispatch lease plus one sweep', () => {
    // Since ADR 0585 P0 the lease is RENEWED, so a dead instance's row becomes
    // claimable a full lease after its LAST renewal — not after its first claim.
    expect(recoveryBoundTerms().leasedMs).toBe(
      RUN_DISPATCH_LEASE_MS + POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS,
    );
  });

  it('has NO single-scalar bound — a max over two classes is lie by aggregation', () => {
    // RFC 0158 UQ1's resolution, in the RFC's own words: "a single scalar would
    // have to be the maximum, which overstates recovery for every faster class."
    // The first version of this module returned exactly that max, and it read as
    // CONSERVATIVE rather than as a defect — wrong in the safe-looking direction,
    // which is why it needed a rule rather than review to catch.
    //
    // This leg is a type-level and shape-level guard at once: `declaredRecoveryBoundMs`
    // requires a class, so no caller can obtain a collapsed number by accident,
    // and `recoveryBoundTerms()` exposes no aggregate field to reach for.
    expect(Object.keys(recoveryBoundTerms()).sort()).toEqual(
      ['leasedMs', 'orphanSweepIntervalMs', 'unleasedMs'],
    );
    expect(declaredRecoveryBoundMs('unleased')).toBe(recoveryBoundTerms().unleasedMs);
    expect(declaredRecoveryBoundMs('leased')).toBe(recoveryBoundTerms().leasedMs);
  });

  it('the two classes are genuinely different — collapsing them would overstate one by 5x', () => {
    // If these ever converge, the per-class split stops earning its complexity
    // and this test should be revisited rather than deleted. Today they differ by
    // the whole dispatch lease, which is the entire reason a scalar was wrong.
    const t = recoveryBoundTerms();
    expect(t.leasedMs).toBeGreaterThan(t.unleasedMs * 4);
  });

  it('each class exceeds the mechanism that produces it — neither can under-promise', () => {
    // The real invariant. A declared bound below its own mechanism would promise
    // recovery before the row is even claimable.
    expect(declaredRecoveryBoundMs('leased')).toBeGreaterThan(RUN_DISPATCH_LEASE_MS);
    // Was `> GRACE_MS` until 2026-08-25. That leg encoded the SAME wrong model as
    // the code: `GRACE_MS` belongs to the orphan lane, which does not produce this
    // bound. Correcting the derivation is what made the test fail — the test could
    // not have caught the defect, because it asserted the defect.
    expect(declaredRecoveryBoundMs('unleased')).toBeGreaterThan(OUTBOX_LEASE_MS);
  });

  it('RFC 0158 §B.3 — liveness and duration are SEPARATE, and the lease is no longer the ceiling', () => {
    // §B.3: a host MUST distinguish the maximum legitimate run duration from the
    // interval within which a live worker demonstrates liveness, and MUST NOT
    // use the duration as the liveness interval.
    //
    // Until ADR 0585 P0 (merged 2026-08-19) this host DID exactly that: the
    // lease had one call site, was never renewed, and therefore answered only
    // "could this run still legitimately be running?". The lease still outlives
    // the ceiling — that is correct and deliberate, because a live long run must
    // never be reclaimed — but liveness is now demonstrated on its own, much
    // shorter interval.
    expect(RUN_DISPATCH_LEASE_MS).toBeGreaterThan(RUN_DURATION_CEILING_MS);
  });
});
