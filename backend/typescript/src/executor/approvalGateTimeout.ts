/**
 * Approval-gate timeout — RFC 0093 §D.1 (pins RFC 0051 UQ 1) per
 * `spec/v1/interrupt-profiles.md` §"Approval-gate timeout and quorum
 * override (RFC 0093)".
 *
 * When an approval gate reaches its timeout, the gate MUST resolve as
 * **rejected** with resolution reason `timeout`, emitting the standard
 * `interrupt.resolved` event with `outcome: "rejected"` and
 * `reason: "timeout"`. Auto-approving on timeout fails open and is
 * non-conformant.
 *
 * The deadline ladder (spec): `timeoutSec` from the node config (carried in
 * the interrupt's `data`) when present; the host's default timeout
 * (`OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC`) when unset; no timeout when
 * neither exists. The host additionally honors the engine-level interrupt
 * `timeoutMs` (suspendSignal.ts) carried in `data` as a gate deadline.
 *
 * Enforcement is two-pronged:
 *   - LAZY: every interrupt read/vote/resolve path calls
 *     `timeoutApprovalGateIfDue` first (routes/interrupts.ts), so a
 *     timed-out gate is rejected before any late vote can land.
 *   - PERIODIC: `sweepExpiredApprovalGates` rides the webhook delivery
 *     worker's tick, so gates with no traffic still resolve on time.
 */

import { openInterruptsForSweep } from './openInterruptSweep.js';
import type { Storage } from '../storage/storage.js';
import type { InterruptRecord } from '../types.js';
import { getEventLog } from './eventLog.js';
import { createLogger } from '../observability/logger.js';
import { recordInterruptResolved } from '../observability/metricSeams.js';

const log = createLogger('approvalGateTimeout');

/** Terminal run statuses — a gate on a terminal run is invalidated, not
 *  re-failed (the run already settled some other way). */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Host-default gate timeout (seconds). Unset ⇒ no host default ⇒ gates
 *  without their own `timeoutSec`/`timeoutMs` never time out (spec ladder). */
function hostDefaultTimeoutSec(): number | null {
  const raw = process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The gate's absolute deadline (epoch ms), or null when the gate has no
 * timeout. Non-approval interrupts never have a gate deadline.
 */
export function approvalGateDeadlineMs(interrupt: InterruptRecord): number | null {
  if (interrupt.kind !== 'approval') return null;
  const createdAt = Date.parse(interrupt.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  const data = (interrupt.data ?? {}) as { timeoutSec?: unknown; timeoutMs?: unknown };
  if (typeof data.timeoutSec === 'number' && data.timeoutSec > 0) {
    return createdAt + data.timeoutSec * 1_000;
  }
  if (typeof data.timeoutMs === 'number' && data.timeoutMs > 0) {
    return createdAt + data.timeoutMs;
  }
  const fallbackSec = hostDefaultTimeoutSec();
  return fallbackSec === null ? null : createdAt + fallbackSec * 1_000;
}

/**
 * RFC 0223 — how a timed-out gate's FAILURE reaches the scheduler. This module
 * owns no workflow catalog, so the resume seam (`dispatchGateResume` in
 * routes/interrupts.ts, the one every resolution uses) is late-bound at boot by
 * `index.ts`, the precedent `setSubWorkflowDispatcher` set.
 */
export type RejectedGateRouter = (
  interrupt: InterruptRecord,
  rejection: { code: string; message: string },
) => Promise<void>;

let router: RejectedGateRouter | null = null;

export function setRejectedGateRouter(r: RejectedGateRouter | null): void {
  router = r;
}

/**
 * If `interrupt` is an UNRESOLVED approval gate past its deadline, resolve it
 * as rejected with reason `timeout` (fail closed) and fail the run the same
 * way a quorum majority-reject does. Returns true when the gate was timed
 * out by THIS call (callers then treat the interrupt as resolved).
 */
export async function timeoutApprovalGateIfDue(
  storage: Storage,
  interrupt: InterruptRecord,
  now: number = Date.now(),
): Promise<boolean> {
  if (interrupt.resolvedAt) return false;
  const deadline = approvalGateDeadlineMs(interrupt);
  if (deadline === null || now < deadline) return false;
  // Refuse BEFORE the CAS when nothing can route the failure: consuming the
  // gate first would strand the run waiting on an interrupt nobody can resolve.
  // The gate stays open (never auto-approved) and the next sweep retries. A
  // direct-fail fallback here would be a second, unrouted reject path — the
  // shape RFC 0223 exists to remove.
  const route = router;
  if (!route) {
    log.error('approval gate due but no rejected-gate router is registered — gate left open', {
      interruptId: interrupt.interruptId,
      runId: interrupt.runId,
    });
    return false;
  }

  const resolvedAt = new Date(now).toISOString();
  // Atomic compare-and-set: only the caller that flips resolved_at NULL→set
  // proceeds to emit events. A concurrent lazy-timeout + periodic sweep (or a
  // late vote) that loses the race returns here without double-emitting
  // `interrupt.resolved`/`run.failed` (ENG-6).
  const won = await storage.resolveInterrupt(interrupt.interruptId, { action: 'reject', reason: 'timeout' }, resolvedAt);
  if (!won) return false;
  // ADR 0556 P1 — recorded only by the CAS WINNER. A losing sweep resolved
  // nothing, and counting its attempt would inflate the age histogram with
  // duplicate observations of one wait.
  recordInterruptResolved(interrupt, 'timeout', resolvedAt);
  // RFC 0093 §D.1 — the standard interrupt.resolved event, outcome rejected,
  // reason timeout.
  await getEventLog().append({
    runId: interrupt.runId,
    nodeId: interrupt.nodeId,
    type: 'interrupt.resolved',
    payload: {
      interruptId: interrupt.interruptId,
      kind: interrupt.kind,
      decision: 'rejected',
      // openwop#1692 — `timeout` is the RECORD-ONLY action value (RFC 0183
      // §A.1): minted by this timer branch, never accepted on a resume. No
      // `resolvedBy` — nobody resolved it, and on a timeout row it must be the
      // host's subject or absent.
      action: 'timeout',
      // `reason` is the CAUSE (gate expired vs quorum rejected), seated on the
      // v2 def by RFC 0186 §A.2.
      reason: 'timeout',
    },
  });

  // RFC 0223 — fail the gate NODE through the scheduler (node.failed
  // approval_rejected, retryable:false), so an all_complete / any_failed edge
  // continues the run and only an unrouted failure fails it, naming the gate.
  // A run that already settled is left untouched (the gate is merely
  // invalidated): the dispatcher skips terminal runs. ADR 0480 (code-review
  // M1) — unlike an operator reject, a timeout IS an outcome, so it is scored
  // (no `operatorAct`); spend is stamped by the executor's terminal seam.
  const run = await storage.getRun(interrupt.runId);
  if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
    await route(interrupt, {
      code: 'approval_rejected',
      message: 'Approval gate timed out (auto-rejected; reason: timeout).',
    });
  }
  log.info('approval gate auto-rejected on timeout', {
    interruptId: interrupt.interruptId,
    runId: interrupt.runId,
    nodeId: interrupt.nodeId,
  });
  return true;
}

/** How many open interrupts one sweep inspects. Sample-grade bound — the
 *  open-interrupt population is small; a huge backlog just takes extra ticks. */
const SWEEP_BATCH = 200;

/**
 * Periodic half of the enforcement (see module banner): time out every due
 * approval gate. Errors are contained per-interrupt so one bad row can't
 * wedge the worker tick that hosts the sweep.
 */
export async function sweepExpiredApprovalGates(storage: Storage, now: number = Date.now()): Promise<number> {
  const open = await openInterruptsForSweep(storage, 'approval-gate-timeout', SWEEP_BATCH);
  let timedOut = 0;
  for (const interrupt of open) {
    try {
      if (await timeoutApprovalGateIfDue(storage, interrupt, now)) timedOut++;
    } catch (err) {
      log.warn('approval gate timeout sweep failed for interrupt', {
        interruptId: interrupt.interruptId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return timedOut;
}
