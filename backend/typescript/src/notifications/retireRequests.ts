/**
 * ADR 1114 (#5868) — a request is over when its step is.
 *
 * A request notification (one that names an interrupt) used to be retired in
 * one place only: the inbox card archived it when the step was decided from
 * that card. Decided in chat, by email link, through the API or the CLI, timed
 * out, or the run failed or was cancelled, it stayed "Approval needed / High /
 * Unread" forever.
 *
 * Every one of those endings already appends an event: `interrupt.resolved`
 * for a decision, an answer or a timeout, and `run.completed` / `run.failed` /
 * `run.cancelled` when the run ends (a cancel resolves its open interrupts
 * without an `interrupt.resolved`; the run's terminal event covers it). So the
 * one retire point is an event-log subscriber, not a call in each of the twelve
 * `resolveInterrupt` callers. It stamps `metadata.resolution` and marks the row
 * read; it never archives, so the person still sees what happened.
 *
 * Best-effort, like every other subscriber: a failure is logged and the inbox
 * degrades to the old behaviour for that row. Idempotent: the storage update
 * only touches rows without a resolution.
 */
import type { EventRecord, RequestResolution, RequestResolutionState } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { getEventLog } from '../executor/eventLog.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('notifications.retire');

const RUN_END_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** How an `interrupt.resolved` payload reads as a request's ending. */
export function resolutionStateOf(payload: unknown): RequestResolutionState {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  switch (p.action) {
    case 'accept':
    case 'edit-accept':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'refine':
      return 'changes-requested';
    case 'timeout':
      return 'timed-out';
    default:
      return p.reason === 'timeout' ? 'timed-out' : 'answered';
  }
}

/** The retire step for one event; exported for the test. Never throws. */
export async function retireRequestsFor(storage: Storage, event: EventRecord): Promise<number> {
  const isResolved = event.type === 'interrupt.resolved';
  if (!isResolved && !RUN_END_TYPES.has(event.type)) return 0;
  try {
    const run = await storage.getRun(event.runId);
    if (!run) return 0;
    const at = event.timestamp ?? new Date().toISOString();
    if (isResolved) {
      const interruptId = (event.payload as { interruptId?: unknown } | null)?.interruptId;
      if (typeof interruptId !== 'string' || interruptId.length === 0) return 0;
      const resolution: RequestResolution = { state: resolutionStateOf(event.payload), at };
      return await storage.resolveRequestNotifications({ tenantId: run.tenantId, runId: run.runId, interruptId, resolution });
    }
    // The run ended: whatever request it still had is no longer waiting.
    return await storage.resolveRequestNotifications({ tenantId: run.tenantId, runId: run.runId, resolution: { state: 'run-ended', at } });
  } catch (err) {
    log.warn('ADR 1114: request retire failed', { runId: event.runId, type: event.type, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

let installed = false;

/** Subscribe once at boot. A second call is a no-op. */
export function installRequestRetirement(storage: Storage): void {
  if (installed) return;
  installed = true;
  getEventLog().subscribe((event) => {
    void retireRequestsFor(storage, event);
  });
}
