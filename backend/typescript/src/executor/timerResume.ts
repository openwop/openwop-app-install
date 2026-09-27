/**
 * Self-advancing timed-wait resolution (ADR 0267 / CDP-E) — the journey timer.
 *
 * A `waitNode` duration/until suspend becomes a `timer` interrupt (see
 * `suspendSignal.mapSuspendKind`). Unlike an approval-gate timeout (which
 * REJECTS + fails the run — `approvalGateTimeout.ts`), an elapsed timer RESUMES
 * the run: the sweep CAS-claims the interrupt, then drives the normal resume
 * (continue) path.
 *
 * §Replay/fork (ADR 0262 ruling #2): the deadline is derived from the **frozen**
 * `interrupt.createdAt` + the persisted `seconds`/`timestamp` in `data` — never
 * wall-clock at wake — so `:fork` recomputes it identically, exactly as
 * `approvalGateDeadlineMs` does. A fork before the timer fires inherits the
 * original `createdAt`/deadline (matches approval-gate behavior).
 */
import type { Storage } from '../storage/storage.js';
import type { InterruptRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { recordInterruptResolved } from '../observability/metricSeams.js';

const log = createLogger('timerResume');

/**
 * Absolute deadline (epoch ms) for a `timer` interrupt, or null when it isn't a
 * timer / carries no usable deadline. `until` uses the absolute persisted
 * timestamp; `duration` (the default) is `createdAt + seconds` — frozen at suspend.
 */
export function timerDeadlineMs(interrupt: InterruptRecord): number | null {
  if (interrupt.kind !== 'timer') return null;
  const createdAt = Date.parse(interrupt.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  const data = (interrupt.data ?? {}) as { kind?: unknown; seconds?: unknown; timestamp?: unknown };
  if (data.kind === 'until' && typeof data.timestamp === 'string') {
    const ts = Date.parse(data.timestamp);
    return Number.isFinite(ts) ? ts : null;
  }
  if (typeof data.seconds === 'number' && data.seconds >= 0) return createdAt + data.seconds * 1000;
  return null;
}

/** How many open interrupts one sweep inspects (mirrors approvalGateTimeout). */
const SWEEP_BATCH = 200;

/**
 * Resolve every due timer by RESUMING its run. `resume` is injected (the
 * `resolveAndResume` continuation) to avoid an executor→routes import cycle.
 * The CAS on `resolveInterrupt` (NULL→set) makes this multi-instance-safe: only
 * the winner drives the resume, so two daemon instances can't double-continue a
 * run. Per-interrupt errors are contained so one bad row can't wedge the tick.
 *
 * §Caveat (matches the approval-gate-timeout posture): the interrupt is CAS-resolved
 * BEFORE `resume` continues the run, so a mid-continue failure leaves the timer
 * resolved without the run advanced (it won't be re-swept). This mirrors
 * `approvalGateTimeout`'s resolve-then-act ordering; a resume-then-resolve variant
 * is a possible hardening follow-up.
 */
export async function sweepDueTimers(
  storage: Storage,
  resume: (interrupt: InterruptRecord) => Promise<void>,
  now: number = Date.now(),
): Promise<number> {
  const open = await storage.listOpenInterruptsAll(SWEEP_BATCH);
  let resumed = 0;
  for (const interrupt of open) {
    try {
      if (interrupt.resolvedAt || interrupt.kind !== 'timer') continue;
      const deadline = timerDeadlineMs(interrupt);
      if (deadline === null || now < deadline) continue;
      const resolvedAt = new Date(now).toISOString();
      const won = await storage.resolveInterrupt(interrupt.interruptId, { elapsed: true, reason: 'timer' }, resolvedAt);
      if (!won) continue; // a concurrent sweep/HTTP resume claimed it
      // ADR 0556 P1 — CAS winner only, as in `approvalGateTimeout`.
      recordInterruptResolved(interrupt, 'timer', resolvedAt);
      await resume(interrupt);
      resumed += 1;
      log.info('timer elapsed — run resumed', { interruptId: interrupt.interruptId, runId: interrupt.runId, nodeId: interrupt.nodeId });
    } catch (err) {
      log.warn('timer resume failed', { interruptId: interrupt.interruptId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return resumed;
}
