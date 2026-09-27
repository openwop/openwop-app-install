/**
 * Core Kanban WorkItem delivery worker (ADR 0738 Phase 4).
 *
 * This is deliberately a small eligibility adapter, not a second workflow
 * engine. It leases core Kanban outbox rows, asks the core aggregate whether
 * the item is eligible, and starts the dynamically bound workflow through
 * `startWorkflowRun` — the same durable run-dispatch outbox used by schedules,
 * heartbeats and other host-owned entry points. A feature/canvas only supplies
 * the proposal and selected tenant-owned workflow; it never installs a runner.
 */

import type { StartRunDeps } from './runStarter.js';
import {
  claimDueWorkItemOutbox,
  claimEligibleWorkItemExecution,
  completeWorkItemOutbox,
  failWorkItemExecutionReservation,
  rescheduleWorkItemOutbox,
  settleWorkItemExecutionFromRun,
  sweepExpiredKanbanOperationReceipts,
  type WorkItemExecutionClaim,
} from './kanbanService.js';
import { deliverReservedWorkItem } from './kanbanWorkItemDelivery.js';
import { onAnyRunTerminal, type RunTerminalStatus } from '../executor/runLifecycle.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import type { Storage } from '../storage/storage.js';
import { getInstanceId } from './instanceId.js';
import { createLogger } from '../observability/logger.js';
import { recordKanbanWorkItemDelivery } from '../observability/metricSeams.js';

const log = createLogger('host.kanbanWorkItemDaemon');
const POLL_INTERVAL_MS = 5_000;
const MAX_OUTBOX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 10_000;
const TERMINAL_LISTENER_KEY = 'kanban-work-item-execution';
const RECEIPT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface KanbanWorkItemDaemon {
  stop(): void;
}

/** One bounded worker pass, exported for deterministic tests. */
export async function sweepKanbanWorkItemOutbox(
  deps: StartRunDeps,
  workerId: string = `kanban-work-${getInstanceId()}`,
  now: number = Date.now(),
): Promise<number> {
  const claimed = await claimDueWorkItemOutbox(workerId, now);
  let started = 0;
  for (const delivery of claimed) {
    let reservation: WorkItemExecutionClaim | null = null;
    try {
      reservation = await claimEligibleWorkItemExecution(
        delivery.entry.tenantId,
        delivery.entry.workItemId,
        workerId,
        'auto',
        now,
      );
      if (reservation.kind === 'skip') {
        recordKanbanWorkItemDelivery('auto', 'not-eligible');
        await completeWorkItemOutbox(delivery, now);
        continue;
      }
      if (reservation.kind === 'defer') {
        recordKanbanWorkItemDelivery('auto', 'deferred');
        await rescheduleWorkItemOutbox(delivery, { availableAt: Date.parse(reservation.availableAt) }, now);
        continue;
      }

      const runId = await deliverReservedWorkItem(deps, reservation, now);
      if (!runId) {
        recordKanbanWorkItemDelivery('auto', 'workflow-unresolved');
        await completeWorkItemOutbox(delivery, now);
        continue;
      }
      await completeWorkItemOutbox(delivery, now);
      recordKanbanWorkItemDelivery('auto', 'started');
      started += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const exhausted = delivery.entry.attempts >= MAX_OUTBOX_ATTEMPTS;
      await rescheduleWorkItemOutbox(delivery, {
        availableAt: now + RETRY_DELAY_MS,
        error,
        deadLetter: exhausted,
      }, now);
      if (exhausted && reservation?.kind === 'started') {
        // The aggregate cannot remain an invisible `starting` reservation
        // after its durable delivery intent has terminally failed.
        await failWorkItemExecutionReservation(
          delivery.entry.tenantId,
          delivery.entry.workItemId,
          reservation.runId,
          `delivery-dead-lettered: ${error}`,
          now,
        );
      }
      recordKanbanWorkItemDelivery('auto', exhausted ? 'dead-lettered' : 'retried');
      log.warn('kanban work-item delivery failed', {
        eventId: delivery.entry.eventId,
        workItemId: delivery.entry.workItemId,
        attempts: delivery.entry.attempts,
        exhausted,
        error,
      });
    }
  }
  return started;
}

/** Attach lifecycle reconciliation at app construction time (not only in
 * `main()`), matching the card-run recovery registration contract. */
export function registerKanbanWorkItemLifecycle(storage: Storage): void {
  onAnyRunTerminal(TERMINAL_LISTENER_KEY, async (runId, status: RunTerminalStatus) => {
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return;
    const run = await storage.getRun(runId);
    if (!run) return;
    await settleWorkItemExecutionFromRun(run.tenantId, runId, status);
  });
}

export function startKanbanWorkItemDaemon(deps: StartRunDeps): KanbanWorkItemDaemon {
  const workerId = `kanban-work-${getInstanceId()}`;
  let running = false;
  let lastReceiptSweepAt = 0;
  const tick = (): void => {
    if (running) return;
    running = true;
    const now = Date.now();
    void sweepKanbanWorkItemOutbox(deps, workerId, now)
      .then(async () => {
        if (now - lastReceiptSweepAt < RECEIPT_SWEEP_INTERVAL_MS) return;
        // Retention is housekeeping, never a delivery precondition. Advance
        // only after the bounded durable sweep settles so a temporary storage
        // failure retries on the next regular tick.
        await sweepExpiredKanbanOperationReceipts(now);
        lastReceiptSweepAt = now;
      })
      .catch((err) => log.warn('kanban work-item sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { running = false; });
  };
  const timer = setInterval(() => runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  timer.unref?.();
  log.info('kanban work-item daemon started', { workerId, pollIntervalMs: POLL_INTERVAL_MS });
  return { stop: () => clearInterval(timer) };
}
