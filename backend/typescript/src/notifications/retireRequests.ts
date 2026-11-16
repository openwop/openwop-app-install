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

/**
 * #5922 — retire the "Input needed" items idle chats left before the suspend
 * manager stopped filing them. `null` when the storage cannot do it (the job
 * stays pending).
 */
export async function retireConversationRequests(storage: Storage, now: () => Date = () => new Date()): Promise<number | null> {
  if (!storage.resolveRequestNotificationsOfKind) return null;
  return await storage.resolveRequestNotificationsOfKind('conversation', { state: 'withdrawn', at: now().toISOString() });
}

/** ADR 1124 D2 — `OPENWOP_NOTIF_STALE_RECONCILE`: `report`, `apply`, or null (off, the default). */
export function staleReconcileMode(): 'report' | 'apply' | null {
  const v = process.env.OPENWOP_NOTIF_STALE_RECONCILE?.trim().toLowerCase();
  return v === 'report' || v === 'apply' ? v : null;
}

/** Per-tenant counts of what the reconcile found. Counts only, never ids or content. */
export interface StaleReconcileCounts { resolved: number; runEnded: number; runDeleted: number; stillOpen: number; unexplained: number }
export interface StaleReconcileReport { mode: 'report' | 'apply'; scanned: number; stamped: number; byTenant: Record<string, StaleReconcileCounts> }

/**
 * ADR 1124 D2 — retire the request rows ADR 1114 never stamped: rows filed
 * before its subscriber existed, and rows whose run was deleted before D1. Each
 * unstamped row is decided from what is still stored:
 *  - its interrupt is resolved → the subscriber's own mapping of the answer;
 *  - its interrupt is gone and the run is gone → `run-deleted`;
 *  - its interrupt is gone and the run is terminal → `run-ended`;
 *  - its interrupt is still open → left alone (it is still waiting);
 *  - its interrupt is gone but the run is NOT terminal → left alone, counted
 *    `unexplained` (nothing here can say how it ended).
 * `report` writes nothing and logs the counts; `apply` stamps through
 * `resolveRequestNotifications` (same row rules, idempotent). Paged; a stamped
 * row drops out of the next page's predicate, so the cursor never skips one.
 */
export async function reconcileStaleRequests(storage: Storage, mode: 'report' | 'apply', pageSize = 500): Promise<StaleReconcileReport | null> {
  if (!storage.listUnstampedRequestRows) return null;
  const report: StaleReconcileReport = { mode, scanned: 0, stamped: 0, byTenant: {} };
  const runs = new Map<string, Awaited<ReturnType<Storage['getRun']>>>();
  let after: { tenantId: string; runId: string; notificationId: string } | undefined;
  for (;;) {
    const page = await storage.listUnstampedRequestRows({ ...(after ? { after } : {}), limit: pageSize });
    if (page.length === 0) break;
    for (const row of page) {
      report.scanned += 1;
      const counts = (report.byTenant[row.tenantId] ??= { resolved: 0, runEnded: 0, runDeleted: 0, stillOpen: 0, unexplained: 0 });
      const interrupt = await storage.getInterrupt(row.interruptId);
      let resolution: RequestResolution | null = null;
      if (interrupt?.resolvedAt) {
        resolution = { state: resolutionStateOf(interrupt.resolvedValue), at: interrupt.resolvedAt };
        counts.resolved += 1;
      } else if (interrupt) {
        counts.stillOpen += 1;
      } else {
        if (!runs.has(row.runId)) runs.set(row.runId, await storage.getRun(row.runId));
        const run = runs.get(row.runId);
        const at = new Date().toISOString();
        if (!run) { resolution = { state: 'run-deleted', at }; counts.runDeleted += 1; }
        else if (RUN_END_TYPES.has(`run.${run.status}`)) { resolution = { state: 'run-ended', at: run.updatedAt ?? at }; counts.runEnded += 1; }
        else counts.unexplained += 1;
      }
      if (resolution && mode === 'apply') {
        report.stamped += await storage.resolveRequestNotifications({ tenantId: row.tenantId, runId: row.runId, interruptId: row.interruptId, resolution });
      }
    }
    const last = page[page.length - 1]!;
    after = { tenantId: last.tenantId, runId: last.runId, notificationId: last.notificationId };
    if (page.length < pageSize) break;
  }
  return report;
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
