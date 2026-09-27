/**
 * The ONE run-cancellation recipe.
 *
 * Extracted from `routes/runs.ts`'s `POST /v1/runs/:runId/cancel` when ADR 0552
 * P2 gave A2A 1.0's `CancelTask` (§D.1: "`CancelTask` → `POST
 * /v1/runs/{runId}/cancel`") a second entry point into the same behaviour. The
 * cascade below is not incidental bookkeeping — `interrupt-profiles.md`
 * §`openwop-interrupt-cascade-cancel` makes it normative — so a second caller
 * that re-implemented "set status, append an event" would leave child runs
 * live and their interrupts resolvable, which is exactly the drift a duplicated
 * recipe produces.
 *
 * The caller owns AUTHORIZATION (the route's `loadOwnedRun` ownership gate; the
 * A2A codec's §E tenant binding) and the response shape. This owns the effect.
 *
 * @see spec/v1/interrupt-profiles.md §openwop-interrupt-cascade-cancel
 * @see docs/adr/0552-a2a-1-adapter-and-versioned-interop.md
 */

import { isTerminalRunStatus } from '@openwop/openwop';
import type { RunRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { stampRunCostOnTerminal } from '../observability/costEmitter.js';
import { foldWorkflowSpendOnTerminal } from './workflowBudgets.js';
import { getEventLog, RunLogClosedError } from '../executor/eventLog.js';
import { notifyRunTerminal } from '../executor/runLifecycle.js';
import { recordInterruptResolved } from '../observability/metricSeams.js';
import { resolveDefinitionForRun, unwindTerminatedRun } from './compensationRuntime.js';
import { compensationTriggerFor } from './compensationUnwind.js';
import { createLogger } from '../observability/logger.js';

// The SDK's `TERMINAL_RUN_STATUSES` predicate, re-exported so a caller reading
// this recipe does not have to know which of the two spellings this file uses.
export { isTerminalRunStatus };

/**
 * Cancel `run` and cascade to its non-terminal children. Returns `'already-terminal'`
 * without touching anything when the run has already finished — the caller
 * decides whether that is a no-op success (the REST route) or a
 * `TaskNotCancelableError` (A2A §D.7).
 */
const log = createLogger('host.runCancel');

export async function cancelRunAndCascade(
  storage: Storage,
  run: RunRecord,
  reason: string,
): Promise<'cancelled' | 'already-terminal'> {
  if (isTerminalRunStatus(run.status)) return 'already-terminal';
  // RFC 0194 §A — `run` is the CALLER's snapshot and can be stale: a run that
  // completed after it was read would otherwise get `run.cancelled` appended
  // behind `run.completed` (a second terminal event; measured in
  // compensation-executor-policy-stamp once the log started refusing it).
  // Re-read the row. A read-then-write is not a CAS (ADR 0740 P2), so the
  // append below still handles losing the race.
  const current = await storage.getRun(run.runId);
  if (!current || isTerminalRunStatus(current.status)) return 'already-terminal';
  const now = new Date().toISOString();
  const prior = { status: current.status, completedAt: current.completedAt, error: current.error };
  await storage.updateRun(run.runId, {
    status: 'cancelled',
    completedAt: now,
    error: { code: 'cancelled', message: reason },
  });
  // ADR 0476 (review M1) — cancelled spend is still spend: stamp it.
  // ADR 0482 §2 — and fold it into the spend-day counter (same figure).
  const cancelSpendUsd = await stampRunCostOnTerminal(storage, run.runId);
  void foldWorkflowSpendOnTerminal(storage, run.runId, cancelSpendUsd);
  try {
    await getEventLog().append({ runId: run.runId, type: 'run.cancelled', payload: { reason } });
  } catch (err) {
    if (!(err instanceof RunLogClosedError)) throw err;
    // Lost the race: the run reached its own terminal event between the re-read
    // and here (possibly on another instance, which the store's RFC 0194 check
    // caught). The LOG is the record, so the row follows it: the terminal status
    // the log closed with, not the stale pre-cancel status (the WHD-22 rule).
    const logged = err.closedBy === 'run.completed' ? 'completed' : err.closedBy === 'run.failed' ? 'failed' : 'cancelled';
    await storage.updateRun(run.runId, { status: logged, completedAt: prior.completedAt ?? now, error: prior.error });
    log.info('cancel_lost_to_terminal', { runId: run.runId, closedBy: err.closedBy });
    return 'already-terminal';
  }
  notifyRunTerminal(run.runId, 'cancelled');

  // Cascade per `interrupt-profiles.md §openwop-interrupt-cascade-cancel`:
  // any non-terminal child runs (rows with parentRunId === this run)
  // MUST also transition to cancelled with reason `parent-cancelled`,
  // and their open interrupts MUST be invalidated so subsequent
  // resolve attempts return 410/409. Children resolve via the
  // parent_run_id index (listRunsByParent — the tenant-walk it
  // replaced is the scan that timed out in the 2026-07-14 incident);
  // the parent/child pair always shares a tenant by construction in
  // subWorkflowDispatcher.ts, so no tenant filter is needed.
  //
  // Partial-failure posture (in-memory tier): each storage write here
  // is independent — if `updateRun(child)` succeeds but a later
  // `resolveInterrupt` fails, the child is cancelled with stale
  // open interrupts, and the already-terminal short-circuit above
  // will stop the next attempt from repairing it. Production deployers
  // wanting auto-recovery should wrap the cascade in a single
  // transaction OR add an idempotent cancel-finalizer that scans
  // `runs WHERE status = 'cancelled' AND EXISTS (open interrupts)`
  // and re-runs the cascade.
  // RFC 0151 §B — `run-cancel` is one of the four accepted triggers, and until
  // 2026-08-18 nothing in this file mentioned compensation: a cancelled run that
  // had committed compensable effects left every obligation stranded at
  // `requested` forever, while a policy naming `run-cancel` sat unused. The
  // executor's only unwind call is in `finalizeRun`, which a cancel never
  // reaches — and #3325's terminal guard closed the last accidental route by
  // returning early once the row is terminal.
  //
  // Unwound AFTER the row is `cancelled` (the run is genuinely terminal, which
  // is the precondition an unwind asserts) and BEFORE the cascade, so a parent's
  // own inverses run before its children are touched.
  await unwindCancelledRun(storage, run);

  const childRows = await storage.listRunsByParent(run.runId);
  for (const child of childRows.filter((r) => !isTerminalRunStatus(r.status))) {
    await storage.updateRun(child.runId, {
      status: 'cancelled',
      completedAt: now,
      error: { code: 'cancelled', message: 'parent-cancelled' },
    });
    const childCancelUsd = await stampRunCostOnTerminal(storage, child.runId);
    void foldWorkflowSpendOnTerminal(storage, child.runId, childCancelUsd);
    await getEventLog().append({
      runId: child.runId,
      type: 'run.cancelled',
      payload: { reason: 'parent-cancelled', parentRunId: run.runId },
    });
    notifyRunTerminal(child.runId, 'cancelled');
    // §B `onParentCancel` — a child unwinds on a PARENT cancel only when its own
    // declaration asks for it. `unwindCancelledRun` consults the child's
    // definition, so a child declaring `onParentCancel: 'skip'` keeps its
    // effects, which is the whole point of the field.
    await unwindCancelledRun(storage, child);
    // Mark any open child interrupts as resolved with a cascade
    // marker so later resolve attempts return 409/410 via the
    // already-resolved guard in routes/interrupts.ts. The resolve
    // path additionally checks run.status === 'cancelled' to upgrade
    // the response to 410 Gone (interrupt-profiles.md preference).
    for (const itr of await storage.listOpenInterrupts(child.runId)) {
      await storage.resolveInterrupt(itr.interruptId, { cascadedFromParent: run.runId }, now);
      // ADR 0556 P1 — a cascade IS a resolution, and one whose age is worth
      // seeing: a long-open approval killed by a parent cancel is work a
      // human was waiting on that will never be asked for again. It rides the
      // extracted recipe so A2A `CancelTask` emits it too, not just the route.
      recordInterruptResolved(itr, 'cascaded', now);
    }
  }
  return 'cancelled';
}

/**
 * Unwind a run that has just been CANCELLED, if its workflow declares any
 * compensation and its policy admits the `run-cancel` trigger.
 *
 * Best-effort and non-fatal by design: a cancel that succeeds must not be
 * reported as a failure because an inverse could not run. The unwind's own
 * ledger records what happened, and `compensationStatus` carries it — that is
 * the surface an operator reads, not this function's return value.
 */
async function unwindCancelledRun(storage: Storage, run: RunRecord): Promise<void> {
  try {
    const definition = await resolveDefinitionForRun(run);
    if (!definition) return;
    await unwindTerminatedRun({ storage, run: { ...run, status: 'cancelled' }, definition, trigger: compensationTriggerFor('run-cancel') });
  } catch (err) {
    log.error('compensation_unwind_on_cancel_failed', {
      runId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
