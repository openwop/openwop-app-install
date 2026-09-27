/**
 * ADR 0585 P0 — the executor's dispatch-lease heartbeat.
 *
 * WHY THE DECISION IS TESTED AND NOT THE CLOCK. The lease is 12 minutes
 * (`RUN_DURATION_CEILING_MS` + 120s), so no test can run a real run past it, and
 * an attempt to would be the timing-dependent test for a timing bug that this
 * repo has already refused to ship once. The renewal DECISION is a pure
 * predicate, and that is what is pinned here — the same seam as
 * `compensationTriggerFor` and the H92 window arm.
 *
 * THE INVARIANT THAT MAKES P0 SAFE TO SHIP ALONE, asserted rather than asserted
 * in prose: a renewal can only ever move the expiry FORWARD. If that ever stops
 * holding, P0 stops being additive and becomes able to reclaim a live run early
 * — in a host with no effect fencing, where the duplicate is a second refund.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isLeaseRenewalDue,
  RUN_LEASE_HEARTBEAT_MS,
  RUN_DISPATCH_LEASE_MS,
  RUN_DURATION_CEILING_MS,
} from '../src/executor/executor.js';

describe('ADR 0585 P0 — when a renewal is due', () => {
  it('is NOT due before one heartbeat has elapsed', () => {
    expect(isLeaseRenewalDue(1_000 + RUN_LEASE_HEARTBEAT_MS - 1, 1_000)).toBe(false);
  });

  it('IS due at exactly one heartbeat, and after', () => {
    expect(isLeaseRenewalDue(1_000 + RUN_LEASE_HEARTBEAT_MS, 1_000)).toBe(true);
    expect(isLeaseRenewalDue(1_000 + RUN_LEASE_HEARTBEAT_MS * 10, 1_000)).toBe(true);
  });

  it('is not due when no time has passed — the loop turns far faster than the heartbeat', () => {
    // The scheduling loop can turn many times per millisecond on a fast graph.
    // If this were `>` on an unchanged clock it would still be false, but the
    // case worth pinning is that a hot loop does not write a lease per turn.
    expect(isLeaseRenewalDue(5_000, 5_000)).toBe(false);
  });

  it('honours an explicit heartbeat, so P1 can retune without editing the predicate', () => {
    expect(isLeaseRenewalDue(1_100, 1_000, 100)).toBe(true);
    expect(isLeaseRenewalDue(1_099, 1_000, 100)).toBe(false);
  });
});

describe('ADR 0585 P0 — the additive invariant', () => {
  /**
   * The renewal writes `Date.now() + RUN_DISPATCH_LEASE_MS`. Since the lease
   * length is a constant and the clock only advances, the new expiry is always
   * >= the old one. This is the property that lets P0 ship without P1.
   */
  it('a renewal never moves the expiry BACKWARD', () => {
    const dispatchedAt = 1_000_000;
    const firstExpiry = dispatchedAt + RUN_DISPATCH_LEASE_MS;
    for (const laterNow of [dispatchedAt, dispatchedAt + 1, dispatchedAt + RUN_LEASE_HEARTBEAT_MS, dispatchedAt + 9 * 60_000]) {
      expect(laterNow + RUN_DISPATCH_LEASE_MS).toBeGreaterThanOrEqual(firstExpiry);
    }
  });

  it('the heartbeat is far shorter than the lease — or renewal could not keep one alive', () => {
    // A non-vacuity floor on the relationship, not on either number. If someone
    // raises the heartbeat past the lease, renewal becomes decorative and the
    // "liveness" claim becomes false without anything else going red.
    expect(RUN_LEASE_HEARTBEAT_MS).toBeLessThan(RUN_DISPATCH_LEASE_MS / 10);
  });

  it('the lease still outlives the advertised run-duration ceiling (P0 changes no wire claim)', () => {
    expect(RUN_DISPATCH_LEASE_MS).toBeGreaterThan(RUN_DURATION_CEILING_MS);
  });
});

describe('ADR 0585 P0 — the predicate can fail (positive control)', () => {
  /**
   * The pre-P0 world is "never renew". If `isLeaseRenewalDue` returned false
   * for every input, every test above except the negative cases would still
   * pass — so the control is that it returns TRUE for a real elapsed interval,
   * which a never-renew stub cannot do.
   */
  it('a never-renew implementation fails the due cases', () => {
    const neverRenew = () => false;
    expect(neverRenew()).toBe(false);
    expect(isLeaseRenewalDue(1_000 + RUN_LEASE_HEARTBEAT_MS, 1_000)).toBe(true);
    expect(isLeaseRenewalDue(1_000 + RUN_LEASE_HEARTBEAT_MS, 1_000)).not.toBe(neverRenew());
  });
});

describe('ADR 0585 P0 — the renewal is actually WIRED, not merely available', () => {
  /**
   * A predicate that nothing calls is the shape this repo keeps finding: the
   * unit tests above would all pass against an executor that never renews.
   * So this asserts the CALL SITES, with a floor.
   *
   * WHAT IT CANNOT SEE, said plainly: it is a source scan. It proves a renewal
   * call exists inside `executeRunBody` and that the predicate guards it; it
   * does not prove the loop reaches it under every schedule. The behavioural
   * version would need a run longer than the 12-minute lease or an injectable
   * clock in production code, and neither is worth its cost here — but the gap
   * is real and is why this is a structural leg rather than the only leg.
   */
  const src = readFileSync(new URL('../src/executor/executor.ts', import.meta.url), 'utf8');

  /**
   * UPDATED BY ADR 0585 P0b, and the update is the interesting part.
   *
   * This case used to read "MORE THAN ONE `setRunDispatchLease` call site —
   * dispatch plus renewal", and P0b made it fail HONESTLY: the renewal no
   * longer uses that method. It uses `renewRunDispatchLeaseIfOwner`, because an
   * unconditional `UPDATE … WHERE run_id = ?` is correct when CLAIMING a run and
   * a defect as a heartbeat — a reclaimed instance would take the run back from
   * its new owner and self-renew.
   *
   * So the floor is re-expressed against the new mechanism rather than relaxed.
   * What it must still catch is what it always caught: an executor that stamps a
   * lease once and never renews it. It now ALSO catches something the old form
   * could not — a renewal that went back to the unconditional stamp.
   */
  it('stamps with the unconditional write and RENEWS with the CAS one — two mechanisms, one each', () => {
    const stamps = src.split('\n').filter((l) => /^[^/]*storage\.setRunDispatchLease\(/.test(l));
    const renewals = src.split('\n').filter((l) => /^[^/]*storage\.renewRunDispatchLeaseIfOwner\(/.test(l));
    expect(stamps.length, 'the dispatch-time claim still uses the unconditional stamp').toBeGreaterThanOrEqual(1);
    expect(renewals.length, 'the heartbeat must renew CONDITIONALLY').toBeGreaterThanOrEqual(1);
    // The floor that survives from the pre-P0b form: a lease that is written
    // once and never renewed is the state this whole ADR exists to end.
    expect(stamps.length + renewals.length, 'expected a dispatch write AND a renewal write').toBeGreaterThanOrEqual(2);
  });

  /**
   * CAUGHT BY SABOTAGE, and the catch is the point. The first version of this
   * suite asserted only that the helper EXISTS — so deleting
   * `await renewDispatchLeaseIfDue()` from the loop left all eleven cases GREEN
   * while the executor renewed nothing. That is the same defect the suite is
   * meant to prevent: a guard that pins the definition and calls it a call.
   */
  it('the loop CALLS the renewal — not merely defines it', () => {
    const calls = src.split('\n').filter((l) => /^[^/]*await renewDispatchLeaseIfDue\(\);/.test(l));
    expect(calls.length, 'the scheduling loop must invoke renewDispatchLeaseIfDue').toBeGreaterThanOrEqual(1);
    // ...and the call must sit INSIDE the scheduling loop, after the deadline
    // check, or it renews once and never again.
    const loopAt = src.indexOf('while (true) {');
    const callAt = src.indexOf('await renewDispatchLeaseIfDue();', loopAt);
    expect(loopAt).toBeGreaterThan(-1);
    expect(callAt, 'the renewal call must appear inside the scheduling loop').toBeGreaterThan(loopAt);
  });

  it('the renewal is guarded by the predicate, not written on every loop turn', () => {
    expect(src).toMatch(/isLeaseRenewalDue\(now, lastLeaseRenewalAt\)/);
    // Advancing the marker BEFORE the await is what stops a slow write from
    // queueing a renewal on every subsequent turn.
    const guard = src.slice(src.indexOf('renewDispatchLeaseIfDue'));
    const advance = guard.indexOf('lastLeaseRenewalAt = now;');
    // ADR 0585 P0b — the heartbeat's write is now the CAS one.
    const write = guard.indexOf('await storage.renewRunDispatchLeaseIfOwner');
    expect(advance).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(advance);
  });

  it('the wait branch wakes for the heartbeat, so one long node cannot starve renewal', () => {
    expect(src).toMatch(/heartbeatDue/);
    expect(src).toMatch(/Promise\.race\(\[settled, retried, deadlineHit, heartbeatDue\]\)/);
  });
});
