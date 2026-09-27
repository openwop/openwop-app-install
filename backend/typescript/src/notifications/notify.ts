/**
 * High-level notification emit helpers — called from the suspend
 * manager (when an interrupt opens) and the executor (when a run
 * fails). Centralizes the type → title/message/priority mapping so
 * the FE bell + panel get consistent shapes regardless of caller.
 *
 * Secret-safety: notification text MUST NOT carry raw provider error
 * strings (which can embed an API key in some upstream responses).
 * Callers pass the **already-classified** `userMessage` from
 * `observability/errorRecovery.ts` (operator-curated, redacted) or a
 * statically-known title; arbitrary metadata is run through
 * `stripSecretsFromPersisted` before persistence as defense-in-depth.
 *
 * Best-effort: the helpers swallow emission failures so an executor
 * doesn't lose data integrity if the notifications table is unreachable
 * (e.g., partial migration). The run-event log remains the source of
 * truth for replay; notifications are a derived, ephemeral surface.
 */

import type { InterruptRecord, NotificationRecord, RunRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { runNoticeAudience } from './runNoticeAudience.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import { getNotificationEmitter } from './emitter.js';
import { deliverApprovalEmail } from '../host/emailApprovalDelivery.js';
import { resolveNotificationRecipients } from '../host/approverResolution.js';

const KIND_LABEL: Record<InterruptRecord['kind'], string> = {
  approval: 'Approval needed',
  clarification: 'Clarification needed',
  refinement: 'Refinement requested',
  cancellation: 'Cancellation confirmation needed',
  'external-event': 'Waiting on external event',
  conversation: 'Conversation in progress',
  // ADR 0267 — a timer self-resolves; it never emits a notification (guarded in
  // suspendManager). Present only to keep the map total.
  timer: 'Timed wait',
  // ADR 0368 — the tour player resolves these live; suppressed like timer.
  'tour-step': 'Tour step',
  'walkthrough-step': 'Walkthrough step',
  // RFC 0199 §C — the user must authorize a provider out of band (ADR 0753 D8).
  credential: 'Authorization needed',
};

const KIND_TYPE: Record<InterruptRecord['kind'], NotificationRecord['type']> = {
  approval: 'openwop-app.workflow.approval-needed',
  clarification: 'workflow.input_needed',
  refinement: 'workflow.input_needed',
  cancellation: 'openwop-app.workflow.approval-needed',
  'external-event': 'workflow.input_needed',
  conversation: 'workflow.input_needed',
  'tour-step': 'workflow.input_needed',
  'walkthrough-step': 'workflow.input_needed',
  timer: 'workflow.input_needed', // unused (timers never notify) — keeps the map total
  credential: 'workflow.input_needed',
};

export async function emitInterruptNotification(
  storage: Storage,
  interrupt: InterruptRecord,
): Promise<void> {
  try {
    const run = await storage.getRun(interrupt.runId);
    if (!run) return;
    const title = KIND_LABEL[interrupt.kind] ?? 'Action needed';
    // Workflow names from `run.metadata` can themselves contain
    // user-supplied text — run through redaction. `workflowId` is
    // engine-controlled so it's safe.
    const workflowLabel = sanitizeForNotification(
      (run.metadata?.workflowName as string | undefined) || run.workflowId,
    );
    // The subject of what's being approved (the gate's prompt) — far more useful
    // to a reviewer than the opaque node id. Bounded + redacted (user-supplied).
    const data = (interrupt.data ?? {}) as { prompt?: unknown; summary?: unknown };
    const rawSubject = typeof data.prompt === 'string' ? data.prompt
      : typeof data.summary === 'string' ? data.summary : undefined;
    const subject = rawSubject ? sanitizeForNotification(rawSubject.slice(0, 140)) : undefined;
    const message = subject
      ? `${workflowLabel} — ${subject}`
      : `${workflowLabel} needs your input`;
    const base = {
      tenantId: run.tenantId,
      type: KIND_TYPE[interrupt.kind] ?? 'openwop-app.workflow.approval-needed',
      priority: (interrupt.kind === 'approval' || interrupt.kind === 'cancellation' ? 'high' : 'normal') as 'high' | 'normal',
      title,
      message,
      runId: interrupt.runId,
      workflowId: run.workflowId,
      nodeId: interrupt.nodeId,
      interruptId: interrupt.interruptId,
      actionUrl: `/inbox`,
      metadata: stripSecretsFromPersisted({ kind: interrupt.kind }),
    };
    // ADR 0075 §D6 — when the gate NAMES approvers, address the notification to
    // each of them (recipientUserId) instead of broadcasting to the whole tenant.
    // An open gate (no named approvers) keeps the tenant-wide broadcast. The
    // recipient set is resolved through the single approver authority (§D1), so
    // "who is told" never drifts from "who may approve". Group/role expansion on
    // the interrupt path arrives with RFC 0104; today this targets the on-wire
    // `approverRefs` subjects (which == userIds for bound approvers, ADR 0003).
    const data2 = (interrupt.data ?? {}) as { approverRefs?: unknown; approversList?: unknown; approverGroupRefs?: unknown; approverRoleRefs?: unknown };
    const subjectRefs = (Array.isArray(data2.approverRefs) ? data2.approverRefs
      : Array.isArray(data2.approversList) ? data2.approversList : []).filter((r): r is string => typeof r === 'string');
    const groupRefs = Array.isArray(data2.approverGroupRefs) ? data2.approverGroupRefs.filter((r): r is string => typeof r === 'string') : [];
    const roleRefs = Array.isArray(data2.approverRoleRefs) ? data2.approverRoleRefs.filter((r): r is string => typeof r === 'string') : [];
    const approverOrgId = (run.metadata as Record<string, unknown> | undefined)?.approverOrgId;
    const recipients = (interrupt.kind === 'approval' || interrupt.kind === 'cancellation')
      ? await resolveNotificationRecipients(
          { approverRefs: subjectRefs, approverGroupRefs: groupRefs, approverRoleRefs: roleRefs },
          { tenantId: run.tenantId, ...(typeof approverOrgId === 'string' ? { orgId: approverOrgId } : {}) },
        )
      : null;
    if (recipients && recipients.length > 0) {
      for (const recipientUserId of recipients) {
        const rec = await getNotificationEmitter().emit({ ...base, recipientUserId });
        // ADR 0478 §2 — decide-by-email for ADDRESSED approval gates: the
        // RFC 0093 token rides as an ARGUMENT (never persisted into the
        // record — inbox reads must not hand out decide capability).
        void deliverApprovalEmail(storage, {
          tenantId: run.tenantId,
          recipientUserId,
          notificationId: rec.notificationId,
          title: base.title,
          message: base.message,
          interruptToken: interrupt.token,
        });
      }
    } else {
      // ADR 0710 — an OPEN gate (nobody named) used to broadcast tenant-wide. In a
      // multi-principal tenant that tells every member about a decision most of
      // them cannot make; it is addressed to the operator role instead. A gate that
      // should reach participants NAMES them, and takes the addressed branch above.
      const gateAudience = runNoticeAudience({ tenantId: run.tenantId, metadata: run.metadata });
      await getNotificationEmitter().emit({
        ...base,
        ...(gateAudience.recipientRole ? { recipientRole: gateAudience.recipientRole } : {}),
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Emit a "your run failed" notification.
 *
 * The caller MUST pass the classified `userMessage` from
 * `classifyDispatchError()` — the raw `error.message` can carry a
 * provider's verbatim response string, which sometimes embeds the
 * API key (some upstreams echo the rejected key back in 401 text).
 * `userMessage` is the operator-curated, redacted form documented in
 * `observability/errorRecovery.ts §"the ONLY string that should be
 * surfaced to a user-facing UI"`.
 */
export async function emitRunFailureNotification(
  storage: Storage,
  runId: string,
  error: { code: string; userMessage: string },
): Promise<void> {
  try {
    const run = await storage.getRun(runId);
    if (!run) return;
    const workflowLabel = sanitizeForNotification(
      (run.metadata?.workflowName as string | undefined) || run.workflowId,
    );
    // ADR 0710 option C — this emit set NEITHER `recipientUserId` NOR
    // `recipientRole`, which the emitter's own contract defines as a TENANT-WIDE
    // BROADCAST, and web push fanned it to every subscribed member. The message is
    // carefully operator-shaped (it demands the classified `userMessage` so a
    // provider's 401 text cannot echo a key) — correct for the audience it was
    // WRITTEN for, and wrong for the one it reached. That is the same species of
    // defect as ADR 0684's org id and ADR 0711's member scope: a component correct
    // for its original audience, reused where the audience moved.
    const audience = runNoticeAudience({ tenantId: run.tenantId, metadata: run.metadata });
    if (audience.aggregatePerJobPerDay && await alreadyNoticedToday(storage, run.tenantId, run.workflowId)) {
      return; // one per job per day — a broken reminder must not page once per participant
    }
    await getNotificationEmitter().emit({
      tenantId: run.tenantId,
      type: 'workflow.failed',
      priority: 'high',
      title: 'Workflow failed',
      // userMessage is the curated, redacted form — safe to surface.
      message: `${workflowLabel}: ${truncate(error.userMessage, 240)}`,
      runId,
      workflowId: run.workflowId,
      actionUrl: `/runs/${runId}`,
      ...(audience.recipientRole ? { recipientRole: audience.recipientRole } : {}),
      metadata: stripSecretsFromPersisted({ errorCode: error.code, noticeAudience: audience.reason }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * ADR 0074 — broadcast a transient `review.updated` cache hint so every live
 * review surface (chat card, Reviews tab, Runs screen, inbox) reconciles the
 * instant a review changes, regardless of which surface/client/user decided it.
 *
 * Emitted at the backend decision OWNERS (`resolveAndResume` for interrupts,
 * `claimApproval`/`rejectApproval` for approvals) AFTER the durable transition,
 * so it is correct no matter which route drove it. Never persisted (the
 * emitter's `signal()` path) and best-effort — a cache hint must never break a
 * decision. The frame carries the unified `reviewId` plus the `runId`/`nodeId`
 * secondary index so run-scoped cards (which hold runId+nodeId, not reviewId)
 * can match it.
 */
export function emitReviewUpdatedSignal(args: {
  tenantId: string;
  reviewId: string;
  status: string;
  runId?: string;
  nodeId?: string;
  interruptId?: string;
  approvalId?: string;
  policy?: { requiredApprovals: number; approvals: number; rejections: number };
}): void {
  try {
    getNotificationEmitter().signal({
      tenantId: args.tenantId,
      type: 'review.updated',
      priority: 'low',
      // No human-facing copy — this frame is a machine cache hint, not an inbox row.
      title: '',
      message: '',
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
      ...(args.interruptId ? { interruptId: args.interruptId } : {}),
      metadata: {
        reviewId: args.reviewId,
        status: args.status,
        ...(args.approvalId ? { approvalId: args.approvalId } : {}),
        ...(args.policy ? { policy: args.policy } : {}),
      },
    });
  } catch {
    /* best-effort — review.updated is a cache hint, never critical */
  }
}

export async function emitRunCompletedNotification(
  _storage: Storage,
  run: RunRecord,
): Promise<void> {
  try {
    const workflowLabel = sanitizeForNotification(
      (run.metadata?.workflowName as string | undefined) || run.workflowId,
    );
    await getNotificationEmitter().emit({
      tenantId: run.tenantId,
      type: 'workflow.completed',
      priority: 'low',
      title: 'Workflow completed',
      message: `${workflowLabel} finished`,
      runId: run.runId,
      workflowId: run.workflowId,
      actionUrl: `/runs/${run.runId}`,
    });
  } catch {
    /* best-effort */
  }
}

// Notification text uses the shared `sanitizeFreeText` primitive from
// `byok/textRedaction.ts`. Aliased here for readability at call sites.
const sanitizeForNotification = sanitizeFreeText;

function truncate(s: string, max: number): string {
  const sanitized = sanitizeForNotification(s);
  return sanitized.length > max ? `${sanitized.slice(0, max - 1)}…` : sanitized;
}

/**
 * ADR 0710 §Decision 2 — has this job already produced an operator failure notice
 * today?
 *
 * Reads SHARED storage rather than an in-process cache: Cloud Run runs many
 * instances, and a per-instance Map would aggregate per instance, i.e. not at all
 * under the load that makes aggregation matter.
 *
 * The scan is BOUNDED, and that bound is a deliberate trade. `listNotifications`
 * cannot filter by type or workflowId, so a very chatty tenant can push today's
 * earlier notice past the window — in which case a second notice is emitted. It
 * fails toward MORE notices, never fewer: a missed aggregation is noise, a false
 * positive would silently swallow the only signal an operator gets.
 */
async function alreadyNoticedToday(storage: Storage, tenantId: string, workflowId: string): Promise<boolean> {
  try {
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await storage.listNotifications({ tenantId, limit: 200, includeArchived: true });
    return rows.some((r) => r.type === 'workflow.failed'
      && r.workflowId === workflowId
      && Date.parse(r.createdAt) >= sinceMs);
  } catch {
    // A failed lookup must not suppress the notice — degrade to emitting.
    return false;
  }
}
