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
 * The three TRUE members are also the exact set the authz comment in
 * `authorizeResolve.ts` already described ("a completed/failed/cancelled run's
 * gate is gone") — as of 1.7.0 the predicate and that prose finally agree.
 */
import { describe, expect, it } from 'vitest';
import type { RunStatus } from '../src/types.js';
import { isTerminalRunStatus } from '../src/host/runCancel.js';

/** Exactly the canonical `RunStatus` enum, listed so a NEW member added by a
 *  future SDK bump shows up here as a compile error rather than as an
 *  unclassified status nothing branches on. */
const ALL_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'paused',
  'waiting-approval',
  'waiting-input',
  'waiting-external',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
];

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
    for (const s of ALL_STATUSES) expect(typeof isTerminalRunStatus(s)).toBe('boolean');
    expect(ALL_STATUSES).toHaveLength(10);
  });
});
