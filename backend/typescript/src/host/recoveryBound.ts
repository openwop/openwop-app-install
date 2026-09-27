/**
 * RFC 0158 §B — the host's DECLARED RECOVERY BOUND, derived from the mechanism
 * that enforces it.
 *
 * §B.4 requires a host to declare "the maximum interval between an instance
 * ceasing to make progress and another instance resuming its work". §B.5 is the
 * part that decides how this file is written:
 *
 *   > The recovery bound MUST be derived from the mechanism that enforces it,
 *   > not stated independently of it. A declared bound that no mechanism
 *   > produces is a claim, not a bound.
 *
 * So there is no literal here. Every number is imported from the constant that
 * actually causes the delay, and `recoveryBoundTerms()` returns the arithmetic
 * alongside the total so a reader can check the derivation rather than trust it.
 * Change a constant and the declared bound moves with it — which is the whole
 * point, and is why `recovery-bound.test.ts` asserts the total EQUALS the
 * recomputed sum rather than a pinned number. A test pinning `750_000` would
 * pass while the mechanism drifted underneath it, and that is precisely the
 * "claim, not a bound" §B.5 forbids.
 *
 * THE TWO CASES ARE DIFFERENT, and collapsing them would overstate the host.
 * A killed instance leaves its runs in one of two states, recovered by two
 * different clocks:
 *
 *   - **Unleased** — killed after the run was accepted but before `executeRun`
 *     claimed a dispatch lease. `dispatch_lease_expires_at` is NULL, so the
 *     orphan query matches as soon as the row clears the sweeper's creation
 *     grace window.
 *   - **Leased** — killed mid-execution. The lease is held and, since ADR 0585
 *     P0, was being renewed; a dead instance stops renewing, so the row becomes
 *     claimable only when the last-written expiry passes. That is a full
 *     `RUN_DISPATCH_LEASE_MS` after the final renewal, and it is much the longer
 *     of the two.
 *
 * THERE IS NO SINGLE DECLARED NUMBER, AND THAT IS THE POINT. The first version
 * of this file returned `max(unleased, leased)` as "the" bound. That is the lie
 * by aggregation RFC 0158's UQ1 resolution forbids, in the RFC's own words: *a
 * single scalar would have to be the maximum, which overstates recovery for
 * every faster class.* The unleased class recovers in ~2.5 min; declaring 12.5
 * for it overstates recovery by 5x on exactly the axis an operator plans
 * around, and it would have been WRONG IN THE SAFE-LOOKING DIRECTION, which is
 * why it read as conservative rather than as a defect.
 *
 * It also fails §B.5 on its own terms: a per-class bound is derived from the
 * mechanism that enforces it, whereas a max is derived from the slowest
 * mechanism and then applied to work that mechanism never touches.
 *
 * WHY THIS IS HONEST RATHER THAN EMBARRASSING. The number is ~12.5 minutes, and
 * §B.6 is explicit that "A host MAY declare a recovery bound of any length. A
 * long bound is conformant; an undeclared or unenforced one is not." A slow
 * declared bound is self-punishing — it delays resumption and says so. The
 * failure this file exists to prevent is the opposite one: declaring an
 * aspirational number no mechanism produces.
 *
 * ADR 0585 P1 shortens the reclaim threshold and will shrink `leasedMs`
 * accordingly, with no edit here.
 */
import { RUN_DISPATCH_LEASE_MS } from '../executor/executor.js';
import {
  OUTBOX_LEASE_MS,
  POLL_INTERVAL_MS,
  ORPHAN_SWEEP_EVERY_N_TICKS,
} from './runDispatchSweeper.js';

export interface RecoveryBoundTerms {
  /** How often the orphan lane actually runs (it is NOT the outbox cadence). */
  readonly orphanSweepIntervalMs: number;
  /** Killed before a dispatch lease existed: creation grace, then a sweep. */
  readonly unleasedMs: number;
  /** Killed holding a lease: the lease must lapse, then a sweep. */
  readonly leasedMs: number;
}

/**
 * The classes a host declares, each with the mechanism that produces it.
 *
 * A consumer that wants "one number" must pick the class its work falls in, not
 * ask this module to collapse them — collapsing is the caller's decision to
 * make badly, not this module's to make for them.
 */
export type RecoveryClass = 'unleased' | 'leased';

/**
 * The bound and the terms that produce it.
 *
 * The orphan lane runs every Nth tick of the sweeper rather than every tick, so
 * its true cadence is the product — reading `POLL_INTERVAL_MS` alone understates
 * the wait by 6x, which is exactly the kind of error a derived-not-stated rule is
 * meant to make impossible to ship silently.
 */
export function recoveryBoundTerms(): RecoveryBoundTerms {
  const orphanSweepIntervalMs = POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS;
  // MEASURED 2026-08-25 — this was DERIVED FROM THE WRONG LANE, and it is the
  // exact §B.5 failure the docblock below warns about, committed in the file that
  // warns about it.
  //
  // The old value was `GRACE_MS + orphanSweepIntervalMs` (150s), taken from the
  // ORPHAN lane. The orphan lane never reaches an unleased run. Three facts, each
  // checkable:
  //
  //   1. The outbox due-query has NO creation-grace window —
  //      `status='pending' AND next_attempt_at <= now AND (claim_expires_at IS
  //      NULL OR claim_expires_at < now)` (`storage/sqlite/index.ts:613`). The
  //      orphan query DOES (`created_at < staleBefore`), which is where the 120s
  //      came from.
  //   2. The outbox row is NOT discharged at dispatch time — it "stays `pending`
  //      on purpose ... the next delivery observes the run out of `pending` and
  //      retires it" (`runDispatchSweeper.ts`). So a run that is `pending` with no
  //      lease ALWAYS still has a live outbox row.
  //   3. Therefore the outbox lane always gets there first, and it runs EVERY
  //      tick rather than every sixth.
  //
  // So the enforcing mechanism is the outbox claim lease plus one tick.
  // §B.5: "a declared bound that no mechanism produces is a claim, not a bound."
  // 150s bounded reality — it was 2.3x too CONSERVATIVE, which is why it read as
  // caution rather than as error — while being produced by a lane that never
  // touches this work. That fails `bound-is-derived` on its own terms.
  const unleasedMs = OUTBOX_LEASE_MS + POLL_INTERVAL_MS;
  const leasedMs = RUN_DISPATCH_LEASE_MS + orphanSweepIntervalMs;
  return { orphanSweepIntervalMs, unleasedMs, leasedMs };
}

/**
 * RFC 0158 §B.4 — the bound this host declares FOR A GIVEN CLASS of work.
 *
 * Deliberately takes the class as a required argument. A no-argument
 * `declaredRecoveryBoundMs()` cannot answer honestly, because the honest answer
 * depends on which mechanism owns the work, and the only no-argument answer
 * available is the `max()` that UQ1 rules out.
 *
 * PUBLISHED as of ADR 0585 P2 — into the RFC 0148 evidence bundle, NOT onto the
 * wire. RFC 0158 §E.10 mints no capability field for this and chose bundle-first
 * publication, so a discovery field would be host-invented wire surface. The
 * bundle carries the per-class ARITHMETIC (`recoveryBound.terms` + `.classes`)
 * because §"`bound-is-derived` evidence" requires a reader be able to RECOMPUTE
 * the bound rather than trust a total.
 *
 * This block previously read "NOT YET PUBLISHED ... Measure first, then declare",
 * gated on which lane actually recovers an unleased run. **That measurement
 * happened** — #3461 established the outbox lane always gets there first (the
 * outbox due-query has no creation grace, and the row is not discharged at
 * dispatch) and re-derived `unleasedMs` from `OUTBOX_LEASE_MS + POLL_INTERVAL_MS`.
 * The precondition was met and this docblock went on stating it as open, which is
 * a block-label outliving its block: the same commit that satisfied the gate left
 * the gate written down. Worth naming, because a stale precondition is more
 * expensive than a stale conclusion — it stops the next reader from even looking.
 */
export function declaredRecoveryBoundMs(cls: RecoveryClass): number {
  const t = recoveryBoundTerms();
  return cls === 'leased' ? t.leasedMs : t.unleasedMs;
}

/** One named addend of a class's recovery bound. */
export interface RecoveryBoundTerm {
  readonly name: string;
  readonly ms: number;
}

/**
 * RFC 0158 §B.5 / §"bound-is-derived" — the ADDENDS of a class's bound, so a
 * reader can recompute it (ADR 0739 D3).
 *
 * This is deliberately NOT a spread of `recoveryBoundTerms()`: that object's
 * three fields are two BOUNDS and one cadence, and they do not sum to either
 * class's figure — a naive projection fails the very row it is served for. Each
 * list here sums, exactly, to `declaredRecoveryBoundMs(cls)`, and
 * `test/rfc0158-recovery-bound.test.ts` pins that equality so the two cannot
 * drift: a new addend in `recoveryBoundTerms()` that is not added here reds.
 */
export function recoveryBoundTermList(cls: RecoveryClass): readonly RecoveryBoundTerm[] {
  return cls === 'leased'
    ? [
        { name: 'runDispatchLeaseMs', ms: RUN_DISPATCH_LEASE_MS },
        { name: 'orphanSweepIntervalMs', ms: POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS },
      ]
    : [
        { name: 'outboxClaimLeaseMs', ms: OUTBOX_LEASE_MS },
        { name: 'outboxPollIntervalMs', ms: POLL_INTERVAL_MS },
      ];
}
