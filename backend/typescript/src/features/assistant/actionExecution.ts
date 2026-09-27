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

import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { stripAutoTerminalOutputRole } from './chainBackedShape.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { onRunTerminal } from '../../executor/runLifecycle.js';
import { actionPolicyOf } from '../../host/governanceService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { runNoticeAudience } from '../../notifications/runNoticeAudience.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { createLogger } from '../../observability/logger.js';
import { decidePendingAction, setPendingActionExecution, type PendingAction, type PendingActionKind } from './assistantService.js';

const log = createLogger('features.assistant.execution');

/**
 * AST-UX-1 — the approver's FAILURE RECEIPT.
 *
 * WHAT WAS WRONG. Approving an outbound action toasts "Approved — {{persona}}
 * will carry it out", the row leaves the inbox, and execution then runs
 * asynchronously. Every `failed` branch below stamped the action row and
 * logged — and told the human who authorised the send NOTHING. The only
 * human-visible `failed` signal was `AgentHealthPanel`'s counter, which is
 * behind the superadmin-gated `/assistant/health` endpoint, on a different
 * page. An authorized email that failed to send was indistinguishable, to the
 * person who authorized it, from one that sent.
 *
 * CORRECTING THE FINDING RATHER THAN INHERITING IT: it is not true that
 * *nothing* reports the failure. `executor/executor.ts:364` fires
 * `emitRunFailureNotification` on every failed RUN, so the two workflow-backed
 * kinds already produced a generic, TENANT-WIDE "Workflow failed:
 * assistant.action.email-send" row. What did not exist is a receipt ADDRESSED
 * TO THE APPROVER that names the action they approved — and for the three
 * branches that never start a run (`nudge`, `servicedesk.reply`, and a missing
 * execution workflow) there was no notification of any kind. Both gaps are what
 * this closes; the generic run-failure row is left alone (it is the operator's
 * signal, this one is the approver's).
 *
 * `type: 'workflow.failed'` is deliberate REUSE, not laziness — it inherits the
 * danger tone, the alert glyph, the type chip, the preference row and the
 * four-locale label that a bespoke type would have to re-declare in six places.
 * `actionUrl` is set ONLY when a run exists: the type's action label is "View
 * run", so pointing it at anything else would ship a link that lies about where
 * it goes. A branch with no run therefore renders no link rather than a wrong
 * one.
 *
 * DELIBERATELY NOT A RETRY. The sibling precedent (Email's partial-failure
 * receipt) offers one, and an assistant action cannot today: the approval is
 * resolved and its CAS consumed, so a re-dispatch would need a new
 * egress-capable route re-deriving `hasAssistantWriteAuthority` — the one thing
 * this feature's reference-grade approval gate exists to make single-winner.
 * Adding that here would risk the exact double-send the gate prevents. The
 * receipt therefore reports and links; the retry is named as deferred work.
 */
async function notifyActionFailed(
  tenantId: string,
  action: PendingAction,
  decidedByUserId: string | undefined,
  detail: { reason: string; runId?: string },
): Promise<void> {
  try {
    await getNotificationEmitter().emit({
      tenantId,
      // Addressed to the human who approved it. Undefined ⇒ tenant-wide, which
      // is the emitter's existing semantic and the honest degradation: better
      // that everyone hears than nobody does.
      // ADR 0710 — "better that everyone hears than nobody does" was the honest
      // reading of a binary choice between a broadcast and silence. There is a
      // third option and it is the right one: address the OPERATOR role. The
      // decider is still preferred when known.
      ...(decidedByUserId !== undefined
        ? { recipientUserId: decidedByUserId }
        : (runNoticeAudience({ tenantId }).recipientRole
            ? { recipientRole: runNoticeAudience({ tenantId }).recipientRole }
            : {})),
      type: 'workflow.failed',
      priority: 'high',
      title: 'The action you approved did not go out',
      // notify.ts discipline — the draft may derive from untrusted connected
      // content; redact before persist + Web-Push.
      message: sanitizeFreeText(`${describeAction(action)} — ${detail.reason}`),
      ...(detail.runId !== undefined ? { runId: detail.runId, actionUrl: `/runs/${detail.runId}` } : {}),
      metadata: { actionId: action.actionId, kind: action.kind, ...(action.approvalId !== undefined ? { approvalId: action.approvalId } : {}) },
    });
  } catch (err) {
    // A swallowed emit here would recreate the exact silence this exists to
    // end, so it is logged rather than dropped (COS-13).
    log.warn('action_failure_notification_failed', { actionId: action.actionId, error: String(err) });
  }
}

/** What the approver approved, in enough detail to recognise it — the same
 *  shape `actionApproval.summarize` puts on the approval card. */
function describeAction(action: PendingAction): string {
  const rawTo = (action.payload as { to?: unknown }).to;
  const to = Array.isArray(rawTo) ? (rawTo as string[]).join(', ') : typeof rawTo === 'string' ? rawTo : undefined;
  const head = action.draft.length > 80 ? `${action.draft.slice(0, 77)}…` : action.draft;
  return `${action.kind}: "${head}"${to ? ` → ${to}` : ''}`;
}

const EXEC_WORKFLOW_BY_KIND: Record<Exclude<PendingActionKind, 'nudge' | 'servicedesk.reply'>, string> = {
  'email.send': 'assistant.action.email-send',
  'calendar.invite': 'assistant.action.calendar-invite',
  'calendar.reschedule': 'assistant.action.calendar-reschedule',
};

/**
 * Boot-time: register the three execution workflows CHAIN-BACKED (WF-COS-1),
 * tenant-agnostic and idempotent.
 *
 * WHAT CHANGED AND WHY. This used to build an in-tree `WorkflowDefinition`
 * literal per kind and hand it to `registerWorkflow()` — the second of this
 * feature's two `PIN_SITE_QUARANTINE` entries, and the pattern `CLAUDE.md`
 * § "Workflows — never hard-code" forbids: a code-pinned workflow is invisible
 * to `/builder` and the `/` picker and is not tenant-editable. The three graphs
 * now ship as `core.openwop.workflows.assistant`
 * (`examples/workflow-chain-packs/assistant`), registered under the SAME
 * workflowIds, so `EXEC_WORKFLOW_BY_KIND` dispatch, the approval's `runId`
 * back-link and every existing run stamp keep resolving.
 *
 * WHAT DID NOT CHANGE, and each is asserted by
 * `test/assistant-chain-backed-workflows.test.ts`: the ADR 0024 §4 Option-C
 * posture (nothing connection-shaped in node config — the opt-in is the
 * run-level `configurable: { connections: ['google'] }` set at dispatch below);
 * the `confirm-action-send` VERDICT GATE, without which a refused send records
 * as `sent` because an HTTP fetch completes on any outcome; and the absence of
 * any secret-shaped string in the definition.
 *
 * REPLAY NOTE: node ids move from the bare `prepare`/`send`/`confirm` to
 * expansion-prefixed ids, so a run created against the OLD definition does not
 * replay def-identically. The expansion is deterministic, so the new shape is
 * stable; the discontinuity is one-time and applies to the pre-existing run
 * population, which the deploy should state rather than assume is zero.
 */
export function registerAssistantActionExecutions(): void {
  for (const workflowId of Object.values(EXEC_WORKFLOW_BY_KIND)) {
    registerChainBackedWorkflow(workflowId, { postProcess: stripAutoTerminalOutputRole });
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
  // COS-1 — the SEND half of the erase/send symmetric pair. A data-subject
  // erasure redacts a pending action and cancels it, but the MIRRORED host
  // approval row is deliberately left alone (`approvalService` made its own
  // argued call), so a human can still approve it afterwards —
  // `decideActionViaApproval` would then flip this row back to `approved` and
  // reach here. Fixing only the erase half would have inverted the property it
  // was fixing: the cancel would look like it held while the send still fired.
  // Refuse, terminally, and say so.
  if (action.erasedAt !== undefined) {
    log.warn('action_execution_refused_erased', { actionId: action.actionId, kind: action.kind, erasedAt: action.erasedAt });
    await decidePendingAction(tenantId, action.actionId, { status: 'rejected' });
    return null;
  }

  const policy = await actionPolicyOf(tenantId, action.kind);
  if (policy !== 'approval-required') {
    log.info('action_execution_policy_skip', { actionId: action.actionId, kind: action.kind, policy });
    // COS-8 — stamp the honest terminal state. `decideActionViaApproval` set the
    // row to `approved` before dispatch; leaving it there was a triple lie —
    // `approved` implies a send that this policy blocks, it inflates
    // `approvalRate` (health counted `approved` as accepted), and it puts a
    // non-human-gated action in the oversight denominator. Under a
    // non-`approval-required` policy the send is suppressed, so say so. The
    // status is stamped on the durable row and read verbatim on :fork (never
    // re-derived), preserving replay/fork determinism.
    await decidePendingAction(tenantId, action.actionId, { status: 'suppressed' });
    void deps.storage
      .appendAudit({
        timestamp: new Date().toISOString(),
        principalId: decidedByUserId ?? 'unknown',
        action: 'assistant.action.execution_policy_skipped',
        resource: `assistant-action:${action.actionId}`,
        outcome: 'skipped',
        payload: { tenantId, kind: action.kind, policy },
      })
      // WF-COS-8 — the fourth swallow in this feature. The audit row is the
      // record that a human's approval was DELIBERATELY not executed under a
      // non-`approval-required` policy; losing it silently makes a policy skip
      // indistinguishable from a lost dispatch.
      .catch((err) => log.warn('action_execution_policy_skip_audit_failed', {
        actionId: action.actionId,
        error: err instanceof Error ? err.message : String(err),
      }));
    return null;
  }

  if (action.kind === 'servicedesk.reply') {
    // ADR 0422 P3 — the approved support reply: append the OUTBOUND message to
    // the ticket thread (idempotent by actionId) and emit the reply-approved
    // host event; CHANNEL DELIVERY composes via the operator's event→workflow
    // binding (openwop-app.servicedesk.ticket-reply-approved → e.g. the whatsapp send
    // node) — the executor stays decoupled from channel adapters, and the send
    // itself runs on a recorded governed run.
    try {
      const { appendMessage } = await import('../service-desk/tickets.js');
      const p = action.payload as { ticketId?: unknown };
      const ticketId = typeof p.ticketId === 'string' ? p.ticketId : '';
      if (!ticketId) throw new Error('servicedesk.reply payload missing ticketId');
      await appendMessage(tenantId, ticketId, {
        messageId: `reply:${action.actionId}`,
        body: sanitizeFreeText(action.draft),
        author: decidedByUserId ? `user:${decidedByUserId}` : 'agent:service-desk',
        direction: 'outbound',
      });
      const { emitHostEvent } = await import('../../host/hostEventDispatcher.js');
      void emitHostEvent({ type: 'openwop-app.servicedesk.ticket-reply-approved', tenantId, payload: { ticketId, actionId: action.actionId } });
      // UX_UPGRADE-assistant R2 (AST2-B2) — `decidePendingAction`, NOT
      // `setPendingActionExecution`. The latter writes `executionRunId` and
      // never touches `status`, so this branch used to leave the row at
      // `approved` forever while stamping the STRING 'sent' into the run-id
      // field. Three lies followed from one wrong setter: a failed reply read
      // as a clean approval (health counted `sent:0, failed:0`; the model's
      // `list-pending-actions` said `approved`, which its prompt reads as
      // en-route); the caller's truthy return made `attachRunId` write
      // `runId:'sent'` onto the approval, so `/reviews` rendered a pointer to a
      // run that does not exist; and the happy path never reached `sent`
      // either. The `nudge` branch below has always done this correctly — this
      // one simply never matched it.
      await decidePendingAction(tenantId, action.actionId, { status: 'sent' });
      return null;
    } catch (err) {
      await decidePendingAction(tenantId, action.actionId, { status: 'failed' });
      log.warn('servicedesk reply execution failed', { actionId: action.actionId, error: err instanceof Error ? err.message : String(err) });
      // AST-UX-1 — the approver hears about it. No run exists on this branch,
      // so the receipt carries no link (see `notifyActionFailed`).
      await notifyActionFailed(tenantId, action, decidedByUserId, { reason: 'the reply could not be appended to the ticket' });
      return null;
    }
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
      // A nudge IS a notification, so this emit can fail for the same reason the
      // nudge did — `notifyActionFailed` logs rather than throws, so a doubly
      // broken emitter degrades to a log line instead of an unhandled rejection.
      await notifyActionFailed(tenantId, action, decidedByUserId, { reason: 'the nudge could not be delivered' });
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
    await notifyActionFailed(tenantId, action, decidedByUserId, { reason: 'it could not be dispatched (no execution workflow was available)' });
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
      if (outcome === 'failed') {
        // The dominant case, and the one the toast promised. The run row is the
        // evidence, so this receipt DOES carry the `/runs/<id>` link. `run` may
        // be null here (the row vanished) — say `did not complete` rather than
        // inventing a status.
        await notifyActionFailed(tenantId, action, decidedByUserId, {
          reason: run ? `the send run ended \`${run.status}\`` : 'the send run did not complete',
          runId,
        });
      }
    })().catch((err) => log.warn('action_terminal_projection_failed', { runId, error: String(err) }));
  });
  return runId;
}
