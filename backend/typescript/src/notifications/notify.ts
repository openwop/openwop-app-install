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
import { gateApproverRefs, resolveNotificationRecipients } from '../host/approverResolution.js';
import { resolveTenantWorkflow } from '../host/resolveLaunchDefinition.js';

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

const nonBlank = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * ADR 1109 D2 — what a request says, read from `interrupt.data` in one place.
 * `title` is the gate's heading; `text` is its prompt, then description, then
 * summary. The wire projector (`interruptRequestedPayload.ts`) reads the same
 * keys, so the bell and the `interrupt.requested` event cannot disagree.
 */
export function requestWordsOf(data: unknown): { title?: string; text?: string } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const d = data as Record<string, unknown>;
  const title = nonBlank(d.title);
  const text = nonBlank(d.prompt) ?? nonBlank(d.description) ?? nonBlank(d.summary);
  return { ...(title ? { title } : {}), ...(text ? { text } : {}) };
}

type WorkflowNameResolver = (tenantId: string, workflowId: string) => Promise<string | undefined>;
let workflowNameResolver: WorkflowNameResolver | null = null;

/**
 * ADR 1109 D3 — late-bound at boot (`index.ts`), like the compensation resolver:
 * the catalog lives on the host suite, not on Storage. The boot wiring resolves
 * through `resolveTenantWorkflow`, so another tenant's id reads as unknown.
 * Unset (tests, a bare boot), the label is today's `workflowName || workflowId`.
 */
export function setNotificationWorkflowNameResolver(fn: WorkflowNameResolver | null): void {
  workflowNameResolver = fn;
}

/**
 * The boot resolver: the definition's `metadata.name`, read through the tenant
 * boundary. A tenant's own copy (`wf.copy.*`, a seed, a builder workflow) carries
 * the name `chainInstantiation` stamped on it; another tenant's id reads as
 * unknown, so the notification falls back to the id and names nothing it cannot see.
 */
export function catalogWorkflowNameResolver(
  catalog: Parameters<typeof resolveTenantWorkflow>[0],
): WorkflowNameResolver {
  return async (tenantId, workflowId) => {
    const name = (await resolveTenantWorkflow(catalog, tenantId, workflowId))?.definition.metadata?.['name'];
    return typeof name === 'string' ? name : undefined;
  };
}

/** `workflowName` (dispatcher-stamped), then the definition's name (a chain's
 *  `label`), then the id. A failed lookup never blocks the notification. */
async function workflowLabelOf(run: RunRecord): Promise<string> {
  const stamped = nonBlank(run.metadata?.workflowName);
  if (stamped) return stamped;
  if (workflowNameResolver) {
    try {
      const name = nonBlank(await workflowNameResolver(run.tenantId, run.workflowId));
      if (name) return name;
    } catch { /* fall through to the id */ }
  }
  return run.workflowId;
}

/**
 * ADR 1109 D4 — what the request is about, from HOST-written run metadata only.
 * Today that is a project schedule's owner (`scheduleDaemon.ts` stamps
 * `schedule.ownerScope` from the job's subject). No name is stored: the SPA
 * resolves it through the projects the reader can see.
 */
export function runSubjectOf(run: Pick<RunRecord, 'metadata'>): { kind: 'project'; id: string } | undefined {
  const schedule = run.metadata?.schedule as { ownerScope?: unknown } | undefined;
  const scope = nonBlank(schedule?.ownerScope);
  if (!scope?.startsWith('project:')) return undefined;
  const id = scope.slice('project:'.length);
  return id ? { kind: 'project', id } : undefined;
}

export async function emitInterruptNotification(
  storage: Storage,
  interrupt: InterruptRecord,
): Promise<void> {
  try {
    const run = await storage.getRun(interrupt.runId);
    if (!run) return;
    // Workflow names from `run.metadata` can themselves contain
    // user-supplied text — run through redaction. `workflowId` is
    // engine-controlled so it's safe.
    const workflowLabel = sanitizeForNotification(await workflowLabelOf(run));
    // ADR 1109 D2 — the gate's own words, through the one reader. Far more useful
    // to a reviewer than the opaque node id. Bounded + redacted (user-supplied).
    const words = requestWordsOf(interrupt.data);
    const title = words.title ? sanitizeForNotification(words.title.slice(0, 140)) : (KIND_LABEL[interrupt.kind] ?? 'Action needed');
    const text = words.text ? sanitizeForNotification(words.text.slice(0, 140)) : undefined;
    const message = text
      ? `${workflowLabel} — ${text}`
      : `${workflowLabel} needs your input`;
    const subject = runSubjectOf(run);
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
      metadata: stripSecretsFromPersisted({ kind: interrupt.kind, ...(subject ? { subject } : {}) }),
    };
    // ADR 0075 §D6 — when the gate NAMES approvers, address the notification to
    // each of them (recipientUserId) instead of broadcasting to the whole tenant.
    // An open gate (no named approvers) keeps the tenant-wide broadcast. The
    // recipient set is resolved through the single approver authority (§D1), so
    // "who is told" never drifts from "who may approve". Group/role expansion on
    // the interrupt path arrives with RFC 0104; today this targets the on-wire
    // `approverRefs` subjects (which == userIds for bound approvers, ADR 0003).
    // ADR 0942 D7 — the one refs builder, so a gate with delegation off does not
    // notify delegates who could not vote on it.
    const gateRefs = gateApproverRefs(interrupt.data);
    const approverOrgId = (run.metadata as Record<string, unknown> | undefined)?.approverOrgId;
    const recipients = (interrupt.kind === 'approval' || interrupt.kind === 'cancellation')
      ? await resolveNotificationRecipients(
          gateRefs,
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
    const workflowLabel = sanitizeForNotification(await workflowLabelOf(run));
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
    // An UNATTENDED run (a schedule or trigger fired it) that fails the SAME way
    // again is not news. A loop whose Google connection lacks a scope failed on
    // every 30-minute tick and notified on every one: the same "High" row, over
    // and over, with no way to tell a new problem from the old one. So an
    // unattended failure notifies once per workflow + error code per 24 h; a
    // DIFFERENT code still notifies at once, and a person-started run always does.
    if (isUnattendedRun(run.metadata) && await alreadyNoticedToday(storage, run.tenantId, run.workflowId, error.code)) {
      return;
    }
    // A refused CONNECTION is fixed in Connections, not by reading the run, so the
    // notice says so and links there (the run stays linked via `runId`).
    const needsReconnect = RECONNECT_CODES.has(error.code);
    await getNotificationEmitter().emit({
      tenantId: run.tenantId,
      type: 'workflow.failed',
      priority: 'high',
      title: needsReconnect ? 'Connection needs attention' : 'Workflow failed',
      // userMessage is the curated, redacted form — safe to surface.
      message: `${workflowLabel}: ${truncate(error.userMessage, 240)}`,
      runId,
      workflowId: run.workflowId,
      actionUrl: needsReconnect ? '/connections' : `/runs/${runId}`,
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
    const workflowLabel = sanitizeForNotification(await workflowLabelOf(run));
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
/** Error codes whose fix is reconnecting an account (`observability/errorRecovery.ts`). */
export const RECONNECT_CODES: ReadonlySet<string> = new Set(['connection_reauth_required', 'connection_scope_missing', 'connection_forbidden']);

/** A schedule or trigger started this run, so nobody is watching it. */
function isUnattendedRun(metadata: unknown): boolean {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const schedule = m.schedule as Record<string, unknown> | undefined;
  return (schedule !== undefined && typeof schedule === 'object') || m.source === 'schedule' || m.source === 'trigger' || m.source === 'webhook';
}

/** A `workflow.failed` notice for this workflow in the last 24 h (and, when given, with this error code). */
async function alreadyNoticedToday(storage: Storage, tenantId: string, workflowId: string, errorCode?: string): Promise<boolean> {
  try {
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await storage.listNotifications({ tenantId, limit: 200, includeArchived: true });
    return rows.some((r) => r.type === 'workflow.failed'
      && r.workflowId === workflowId
      && (errorCode === undefined || (r.metadata as { errorCode?: unknown } | undefined)?.errorCode === errorCode)
      && Date.parse(r.createdAt) >= sinceMs);
  } catch {
    // A failed lookup must not suppress the notice — degrade to emitting.
    return false;
  }
}
