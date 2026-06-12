/**
 * Action execution (ADR 0023 §12 T6) — what an approved action DOES.
 *
 * Per the architect review: the winning approval claim is the only dispatch
 * site (the CAS in `resolveApproval` already guarantees exactly one winner),
 * and execution rides the shared `runStarter` — replay/fork/observability and
 * the budget rails are inherited, never re-implemented.
 *
 * Per kind:
 *   - `nudge` executes INTERNALLY: it IS a notification (ADR 0010 inbox) —
 *     no provider write, marked `sent` immediately.
 *   - `email.send` / `calendar.invite` / `calendar.reschedule` dispatch the
 *     boot-registered `assistant.action.<kind>` workflow: a pure
 *     `prepare-action-request` transform feeding `core.openwop.http.fetch`
 *     with the ADR 0024 Phase D `config.connection` annotation. The run
 *     executes AS the approving human (`metadata.actingUserId` = the
 *     decider — D2: send-authority is the principal's alone), so the
 *     resolver picks THEIR write-scoped connection and fails closed when
 *     write re-consent (Phase C) was never granted.
 *
 * Outcome tracking: the action records `executionRunId`; `onRunTerminal`
 * projects the run's terminal state onto the action (`sent` / `failed`).
 * A lost in-process listener (cold start) leaves the action `approved` with
 * the run still inspectable via /v1/runs — degraded visibility, never a
 * duplicate send (the run itself is the single execution).
 */

import type { WorkflowDefinition } from '../../executor/types.js';
import { registerWorkflow } from '../../host/workflowsRegistry.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { onRunTerminal } from '../../executor/runLifecycle.js';
import { actionPolicyOf } from '../../host/governanceService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { createLogger } from '../../observability/logger.js';
import { decidePendingAction, setPendingActionExecution, type PendingAction, type PendingActionKind } from './assistantService.js';

const log = createLogger('features.assistant.execution');

const EXEC_WORKFLOW_BY_KIND: Record<Exclude<PendingActionKind, 'nudge'>, string> = {
  'email.send': 'assistant.action.email-send',
  'calendar.invite': 'assistant.action.calendar-invite',
  'calendar.reschedule': 'assistant.action.calendar-reschedule',
};

function execDefinition(kind: Exclude<PendingActionKind, 'nudge'>): WorkflowDefinition {
  const url =
    kind === 'email.send'
      ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
      : kind === 'calendar.invite'
        ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
        : 'https://www.googleapis.com/calendar/v3/calendars/primary/events/{{eventId}}';
  return {
    workflowId: EXEC_WORKFLOW_BY_KIND[kind],
    nodes: [
      { nodeId: 'prepare', typeId: 'feature.assistant.nodes.prepare-action-request', config: {} },
      {
        nodeId: 'send',
        typeId: 'core.openwop.http.fetch',
        // ADR 0024 §4 / Option C — the credential opt-in is run-level
        // (`configurable.connections`, set at dispatch below); node config
        // stays the pack's published schema, and the host injects the
        // approving user's write-scoped token when the URL matches Google's
        // curated apiHosts. Nothing here carries or names a secret.
        config: {
          url,
          method: kind === 'calendar.reschedule' ? 'PATCH' : 'POST',
        },
      },
      // The verdict gate: fetch completes on ANY outcome (side-effect-once),
      // so this node fails the run on non-2xx — the terminal projection then
      // marks the action `failed` instead of falsely `sent`.
      { nodeId: 'confirm', typeId: 'feature.assistant.nodes.confirm-action-send', config: {} },
    ],
    edges: [
      { edgeId: 'prepare→send', sourceNodeId: 'prepare', targetNodeId: 'send' },
      { edgeId: 'send→confirm', sourceNodeId: 'send', targetNodeId: 'confirm' },
    ],
  };
}

/** Boot-time: register the execution workflow definitions (tenant-agnostic). */
export function registerAssistantActionExecutions(): void {
  for (const kind of Object.keys(EXEC_WORKFLOW_BY_KIND) as Array<Exclude<PendingActionKind, 'nudge'>>) {
    registerWorkflow(execDefinition(kind));
  }
}

/**
 * Execute an action whose approval claim just WON (the caller holds the CAS
 * win — this is never reached twice for one action). Marks the action
 * `sent`/`failed` per the outcome; returns the execution runId when one was
 * dispatched.
 */
export async function executeApprovedAction(
  deps: StartRunDeps,
  tenantId: string,
  action: PendingAction,
  decidedByUserId?: string,
): Promise<string | null> {
  // ADR 0028 — per-kind policy, consulted at the ONE dispatch site:
  // 'draft-only' records the human's decision but egresses nothing
  // (the action stays 'approved'; the card shows the decided state);
  // 'disabled' should never reach here (enqueue refuses) — treated the same,
  // fail closed.
  const policy = await actionPolicyOf(tenantId, action.kind);
  if (policy !== 'approval-required') {
    log.info('action_execution_policy_skip', { actionId: action.actionId, kind: action.kind, policy });
    void deps.storage
      .appendAudit({
        timestamp: new Date().toISOString(),
        principalId: decidedByUserId ?? 'unknown',
        action: 'assistant.action.execution_policy_skipped',
        resource: `assistant-action:${action.actionId}`,
        outcome: 'skipped',
        payload: { tenantId, kind: action.kind, policy },
      })
      .catch(() => {});
    return null;
  }

  if (action.kind === 'nudge') {
    // A nudge IS the notification — internal write, no provider egress.
    try {
      await getNotificationEmitter().emit({
        tenantId,
        type: 'assistant.nudge',
        priority: 'normal',
        title: 'Nudge from your assistant',
        // notify.ts discipline — draft text may derive from untrusted
        // connected content; redact before persist + Web-Push.
        message: sanitizeFreeText(action.draft),
        actionUrl: '/inbox',
        metadata: { actionId: action.actionId },
      });
      await decidePendingAction(tenantId, action.actionId, { status: 'sent' });
    } catch (err) {
      log.warn('nudge_delivery_failed', { actionId: action.actionId, error: String(err) });
      await decidePendingAction(tenantId, action.actionId, { status: 'failed' });
    }
    return null;
  }

  const workflowId = EXEC_WORKFLOW_BY_KIND[action.kind];
  const runId = await startWorkflowRun(deps, {
    tenantId,
    workflowId,
    // ADR 0024 §4 / Option C — run-level credential opt-in for the send.
    configurable: { connections: ['google'] },
    inputs: {
      action: { actionId: action.actionId, kind: action.kind, payload: action.payload, draft: action.draft },
    },
    metadata: {
      // D2 — the execution acts AS the approving human; the Phase-D seam
      // keys the (write-scoped) credential off this identity and fails
      // closed when the user never granted write re-consent.
      ...(decidedByUserId !== undefined ? { actingUserId: decidedByUserId } : {}),
      assistantAction: { actionId: action.actionId, ...(action.approvalId !== undefined ? { approvalId: action.approvalId } : {}), source: 'assistant-action' },
    },
  });
  if (!runId) {
    log.error('action_execution_workflow_missing', { actionId: action.actionId, workflowId });
    await decidePendingAction(tenantId, action.actionId, { status: 'failed' });
    return null;
  }

  await setPendingActionExecution(tenantId, action.actionId, runId);
  // Project the run's terminal state onto the action. In-process only —
  // a cold start mid-run leaves the action 'approved' with the run still
  // the source of truth (never a duplicate dispatch).
  onRunTerminal(runId, () => {
    void (async () => {
      const run = await deps.storage.getRun(runId);
      const outcome = run?.status === 'completed' ? 'sent' : 'failed';
      await decidePendingAction(tenantId, action.actionId, { status: outcome });
      log.info('action_execution_terminal', { actionId: action.actionId, runId, outcome });
    })().catch((err) => log.warn('action_terminal_projection_failed', { runId, error: String(err) }));
  });
  return runId;
}
