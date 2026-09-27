/**
 * Durable work-item trigger delivery.
 *
 * A Kanban card movement is a work-item transition, not a second workflow
 * runner. This module is the one adapter from that transition to the existing
 * RFC 0083 trigger bridge. REST routes, workflow nodes, and future canvas
 * adapters all call this service, so they share the same deduplication,
 * retry/dead-letter, causation, run attribution, and executor path.
 */

import { randomUUID } from 'node:crypto';
import { insertRunWithStartContext } from './runInsert.js';
import { resolveLaunchWorkflow } from './resolveLaunchDefinition.js';
import type { RunRecord } from '../types.js';
import type { HostAdapterSuite } from './index.js';
import type { Storage } from '../storage/storage.js';
import { executeRun } from '../executor/executor.js';
import { getEventLog } from '../executor/eventLog.js';
import { recordRunAttribution } from './agentRunActivityIndex.js';
import { getRosterEntry } from './rosterService.js';
import { getBoard, type KanbanTriggerDirective } from './kanbanService.js';
import { createLogger } from '../observability/logger.js';
import { deliver, makeDedupKey, registerHostDerivedSubscription } from './triggerBridgeService.js';

const log = createLogger('host.kanbanTriggerDelivery');

export interface KanbanTriggerDeliveryDeps {
  storage: Storage;
  hostSuite: Pick<HostAdapterSuite, 'workflowCatalog' | 'providerPolicyResolver'>;
}

export interface StartedKanbanTrigger {
  runId: string;
  attribution: Record<string, unknown>;
}

let configuredDeps: KanbanTriggerDeliveryDeps | null = null;

/** Wire the normal host dependencies once at boot. Kept as late binding because
 * `ctx.kanban` is built per run and never owns a Storage or HostAdapterSuite. */
export function setKanbanTriggerDeliveryDeps(deps: KanbanTriggerDeliveryDeps): void {
  configuredDeps = deps;
}

/** Dispatch from a workflow-facing host surface. A missing boot binding is an
 * honest capability failure rather than a move that silently omits its trigger. */
export async function dispatchConfiguredKanbanTrigger(
  tenantId: string,
  trigger: KanbanTriggerDirective,
): Promise<StartedKanbanTrigger | null> {
  if (!configuredDeps) {
    throw Object.assign(new Error('Kanban trigger delivery is not initialized on this host.'), {
      code: 'host_capability_missing',
    });
  }
  return startKanbanTriggerRun(configuredDeps, tenantId, trigger);
}

/** Resolve the transition's workflow, create + dispatch a run through the
 * durable trigger bridge, and emit content-free attribution events. Returns
 * null for a dangling/disabled trigger without rolling back the card move. */
export async function startKanbanTriggerRun(
  deps: KanbanTriggerDeliveryDeps,
  tenantId: string,
  trigger: KanbanTriggerDirective,
): Promise<StartedKanbanTrigger | null> {
  const { storage, hostSuite } = deps;
  const wf = await resolveLaunchWorkflow(hostSuite.workflowCatalog, tenantId, trigger.workflowId);
  if (!wf) {
    log.warn('kanban_trigger_workflow_not_found', {
      workflowId: trigger.workflowId,
      boardId: trigger.boardId,
      cardId: trigger.cardId,
    });
    return null;
  }

  const board = await getBoard(trigger.boardId);
  const roster = board?.rosterId ? await getRosterEntry(board.tenantId, board.rosterId) : null;
  if (board?.rosterId && (!roster || !roster.enabled)) {
    log.info('kanban_trigger_skipped_disabled_roster', {
      boardId: trigger.boardId,
      rosterId: board.rosterId,
      reason: roster ? 'disabled' : 'missing',
    });
    return null;
  }

  const attribution: Record<string, unknown> = {
    boardId: trigger.boardId,
    cardId: trigger.cardId,
    fromColumnId: trigger.fromColumnId,
    toColumnId: trigger.toColumnId,
    workflowId: trigger.workflowId,
  };
  if (roster) {
    attribution.rosterId = roster.rosterId;
    attribution.persona = roster.persona;
    attribution.agentId = roster.agentRef.agentId;
  } else if (board?.ownerUserId) {
    attribution.ownerUserId = board.ownerUserId;
  }

  const subscriptionId = await registerHostDerivedSubscription('kanban', trigger.boardId, {
    tenantId,
    source: 'queue',
    label: `Kanban board ${trigger.boardId}`,
  });
  const dedupKey = makeDedupKey(subscriptionId, trigger.cardId, trigger.toColumnId);
  attribution.triggerSource = 'queue';
  attribution.triggerSubscriptionId = subscriptionId;

  const result = await deliver({
    subscriptionId,
    dedupKey,
    fire: async (deliveryId) => {
      const runId = randomUUID();
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId,
        workflowId: trigger.workflowId,
        tenantId,
        status: 'pending',
        inputs: null,
        metadata: { launchResolved: wf.launchResolved, kanban: attribution },
        causationId: deliveryId,
        configurable: {},
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(storage, run, { definition: wf.definition });
      await recordRunAttribution(storage, run);
      await getEventLog().append({ runId, type: 'openwop-app.kanban.card-moved', payload: attribution });
      setImmediate(() => {
        executeRun(storage, run, wf.definition, { policyResolver: hostSuite.providerPolicyResolver }).catch((err) => {
          log.error('kanban_trigger_dispatch_failed', { runId, error: err instanceof Error ? err.message : String(err) });
        });
      });
      return runId;
    },
  });

  if ((result.outcome === 'delivered' || result.outcome === 'deduped') && result.runId) {
    if (result.outcome === 'delivered') {
      await getEventLog().append({
        runId: result.runId,
        type: 'trigger.delivery.attempted',
        payload: { subscriptionId, dedupKey, attempt: result.attempts, outcome: 'delivered', runId: result.runId },
      });
    }
    return { runId: result.runId, attribution };
  }
  return null;
}
