/** Shared delivery adapter for reusable Kanban WorkItems.
 *
 * Both the durable auto-dispatch worker and an explicit human "Run" action use
 * this one function. It delegates run creation to `startWorkflowRun`, whose
 * run-dispatch outbox and replay/fork semantics are the canonical workflow
 * runtime; this module owns no queue or executor of its own.
 */

import type { StartRunDeps } from './runStarter.js';
import { startWorkflowRun } from './runStarter.js';
import {
  failWorkItemExecutionReservation,
  markWorkItemExecutionStarted,
  type WorkItemExecutionClaim,
} from './kanbanService.js';

export async function deliverReservedWorkItem(
  deps: StartRunDeps,
  reservation: Extract<WorkItemExecutionClaim, { kind: 'started' }>,
  now: number = Date.now(),
): Promise<string | null> {
  const runId = await startWorkflowRun(deps, {
    tenantId: reservation.item.tenantId,
    workflowId: reservation.item.workflowId!,
    runId: reservation.runId,
    ...(reservation.item.input ? { inputs: reservation.item.input } : {}),
    metadata: {
      kanbanWorkItem: {
        workItemId: reservation.item.workItemId,
        boardId: reservation.item.boardId,
        cardId: reservation.item.cardId,
        scopeKind: reservation.item.scope.kind,
        sourceKind: reservation.item.source.kind,
        sourceId: reservation.item.source.id,
      },
    },
  });
  if (!runId) {
    await failWorkItemExecutionReservation(
      reservation.item.tenantId,
      reservation.item.workItemId,
      reservation.runId,
      'workflow-unresolved',
      now,
    );
    return null;
  }
  if (!await markWorkItemExecutionStarted(reservation.item.tenantId, reservation.item.workItemId, runId, now)) {
    // The deterministic run was accepted but our card/aggregate projection
    // lost a CAS race. Let the durable outbox retry the same run id until the
    // projection is recorded; never claim success and strand lifecycle sync.
    throw new Error(`Kanban WorkItem '${reservation.item.workItemId}' run '${runId}' could not be recorded.`);
  }
  return runId;
}
