/**
 * The run-status terminality the cancel paths key on — pinned at the HOST tier
 * because it is owned by a dependency.
 *
 * `host/runCancel.ts` imports `isTerminalRunStatus` from `@openwop/openwop` and
 * re-exports it, and four live branches key on it:
 *
 *   - `cancelRunAndCascade` short-circuits to `'already-terminal'` (runCancel.ts);
 *   - the parent cancel CASCADE filters children by it (runCancel.ts);
 *   - A2A `CancelTask` maps it to `TASK_NOT_CANCELABLE` (a2aService.ts);
 *   - the conversation-resolve authz fails closed on it (exchange/authorizeResolve.ts).
 *
 * So the set is not a detail of a library we happen to depend on — it decides
 * whether a parked run can ever be cancelled. It moved under us once already:
 * MEASURED across the `^1.2.0` -> `^1.7.0` pin bump, `isTerminalRunStatus(
 * 'waiting-external')` returned **true** at 1.2.0 and returns **false** at
 * 1.7.0 (RFC 0094 widened `RunStatus`, and the SDK's own notes call the old
 * classification a misclassification). `executor/executor.ts` mints
 * `waiting-external` for an `external-event` interrupt, so that flip is live
 * here, and it is a fix in both directions it touches:
 *
 *   - a run parked on an external event that never arrives used to answer
 *     `'already-terminal'` to its own cancel — i.e. it could not be cancelled
 *     at all — and can now be cancelled;
 *   - such a run as a CHILD used to be filtered OUT of the parent cancel
 *     cascade, which contradicts `interrupt-profiles.md`
 *     §openwop-interrupt-cascade-cancel ("non-terminal children MUST also
 *     transition to cancelled"). It is now cascaded.
 *
 * Nothing in the app's own types could have caught that: the signature is
 * unchanged and `tsc` stays green either way. Hence a behavioural pin. If a
 * later bump reclassifies any of these, this test fails and names the branch
 * that silently changes rather than letting a stranded-run regression ship
 * green.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): `waiting-external` made
 * terminal (`8fw2g3-term-waitext`), `cancelling` made terminal
 * (`-term-cancelling`), an unhandled member returning `undefined`
 * (`-term-enum-r2`). The round-1 `-term-enum-vacuous` probe was a no-op
 * (`paused` is already false) and the old case 4 could not fail anyway.
 *
 * The three TRUE members are also the exact set the authz comment in
 * `authorizeResolve.ts` already described ("a completed/failed/cancelled run's
 * gate is gone") — as of 1.7.0 the predicate and that prose finally agree.
 */
import { describe, expect, it } from 'vitest';
import type { RunStatus } from '../src/types.js';
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from '@openwop/openwop';
import { isTerminalRunStatus } from '../src/host/runCancel.js';

/** The expected classification of EVERY canonical `RunStatus`. A
 *  `Record<RunStatus, boolean>` is exhaustive at compile time: a member added to
 *  the type by a future SDK bump is a missing-key compile error here (a plain
 *  `RunStatus[]` literal is not — it compiles with a member left out, which is
 *  what the previous version of this file wrongly claimed). Case 4 also checks
 *  the keys against the SDK's RUNTIME status lists, for a member the type does
 *  not carry. */
const EXPECTED: Record<RunStatus, boolean> = {
  pending: false,
  running: false,
  paused: false,
  'waiting-approval': false,
  'waiting-input': false,
  'waiting-external': false,
  cancelling: false,
  completed: true,
  failed: true,
  cancelled: true,
};
const ALL_STATUSES = Object.keys(EXPECTED) as RunStatus[];

const TERMINAL: RunStatus[] = ['completed', 'failed', 'cancelled'];

describe('run-status terminality (the predicate the cancel paths key on)', () => {
  it('treats exactly completed/failed/cancelled as terminal', () => {
    const terminal = ALL_STATUSES.filter((s) => isTerminalRunStatus(s));
    expect(terminal.sort()).toEqual([...TERMINAL].sort());
  });

  it('keeps a run parked on an external event CANCELLABLE (it is not terminal)', () => {
    // The 1.2.0 -> 1.7.0 flip. `true` here means an `external-event` interrupt
    // strands its run: `cancelRunAndCascade` answers 'already-terminal' and the
    // parent cascade skips it as a child.
    expect(isTerminalRunStatus('waiting-external')).toBe(false);
  });

  it('treats an in-flight cancel as non-terminal', () => {
    // RFC 0094 §B. This host never writes `cancelling` today (it transitions
    // straight to `cancelled`), so this is a claim about the VOCABULARY, not
    // about a reachable state here — which is precisely why it needs pinning:
    // there is no host code path whose failure would reveal it.
    expect(isTerminalRunStatus('cancelling')).toBe(false);
  });

  it('classifies every member of the enum, so none is silently unhandled', () => {
    // The table covers exactly the SDK's runtime vocabulary (a member the SDK
    // lists but the table lacks, or the reverse, reds here)…
    const sdk: readonly RunStatus[] = [...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES];
    expect([...ALL_STATUSES].sort()).toEqual([...sdk].sort());
    // …and the predicate returns the table's exact boolean for each member
    // (an `undefined` for an unhandled member is not `false`).
    const actual = Object.fromEntries(ALL_STATUSES.map((s) => [s, isTerminalRunStatus(s)]));
    expect(actual).toEqual(EXPECTED);
  });
});
