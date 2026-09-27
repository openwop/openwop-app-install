/**
 * GRADING PROBE — "Strategy activation approval gate" (FEATURES.md ordinal 225,
 * ADR 0230 §B3 / ADR 0597 §3). Evidence only. GREEN + CI-safe.
 *
 * Headline #2 (gate integrity) is CLEAN and the DECIDE side is already tested at
 * the STATE level (`strategy-governance.test.ts:102-121` — reject leaves the
 * strategy draft). This probe witnesses the complementary, structurally-stronger
 * property: the SUBMIT-side gate is a TOTAL FUNCTION over the status union, which
 * is what closes the whole "approval-gate-that-does-not-gate" class (ADR 0597 §3 —
 * the gate that shipped keyed on two hand-picked transitions let `paused` bypass it
 * via pause→edit→activate; the fix re-expressed it over the STATE SET).
 *
 * SGP-1: `requiresActivationApproval` is keyed on the DESTINATION — EVERY status
 *     that is not already `active` must pass the gate to become active, and
 *     `active → active` does not. So no origin state (draft/paused/completed/
 *     archived) can reach `active` without approval — the bypass is structurally
 *     impossible, not enumerated.
 * SGP-2: `protectedEditRequiresReapproval` matches the posture EXACTLY —
 *     approved-and-non-terminal (active, paused) ⇒ re-approve; draft (not yet
 *     approved) and terminal (completed, archived) ⇒ no re-approve (a terminal
 *     edit must not un-archive into draft — a withheld escalation).
 * SGP-3: the posture is TOTAL — every StrategyStatus has an entry (the runtime
 *     mirror of the `satisfies Record<StrategyStatus,…>` compile-guard; a new
 *     status added without a decided posture fails here).
 */
import { describe, it, expect } from 'vitest';
import { STRATEGY_STATUSES } from '../src/features/strategy/types.js';
import {
  requiresActivationApproval,
  protectedEditRequiresReapproval,
  STATUS_GATE_POSTURE,
} from '../src/features/strategy/activationApproval.js';

describe('ADR 0597 §3 strategy activation gate — total-function anti-bypass (by execution)', () => {
  it('SGP-1: every non-active origin → active requires approval; active → active does not (destination-keyed)', () => {
    for (const s of STRATEGY_STATUSES) {
      expect(requiresActivationApproval(s, 'active')).toBe(s !== 'active');
    }
    // A non-active destination never trips the activation gate (it is the check for `active` only).
    expect(requiresActivationApproval('draft', 'paused')).toBe(false);
  });

  it('SGP-2: protected-edit re-approval matches the posture — approved & non-terminal only', () => {
    const expected: Record<string, boolean> = {
      draft: false,      // not yet approved
      active: true,      // approved, non-terminal → re-approve
      paused: true,      // approved, non-terminal → re-approve (the state the enumerated gate missed)
      completed: false,  // terminal → no un-archive escalation
      archived: false,   // terminal → no un-archive escalation
    };
    for (const s of STRATEGY_STATUSES) {
      expect(protectedEditRequiresReapproval(s)).toBe(expected[s]);
    }
  });

  it('SGP-3: the gate posture is a TOTAL function of the status union (no status left unposted)', () => {
    for (const s of STRATEGY_STATUSES) {
      expect(STATUS_GATE_POSTURE[s]).toBeDefined();
      expect(typeof STATUS_GATE_POSTURE[s].approved).toBe('boolean');
      expect(typeof STATUS_GATE_POSTURE[s].terminal).toBe('boolean');
    }
    // No extra keys beyond the declared status union.
    expect(Object.keys(STATUS_GATE_POSTURE).sort()).toEqual([...STRATEGY_STATUSES].sort());
  });
});
