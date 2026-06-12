/**
 * Assistant action ↔ approval-loop bridge (ADR 0023 §12 T4, the ADR 0025 §4
 * "no new approval store" pin made literal).
 *
 * - `enqueueActionWithApproval()` — the ONE enqueue path: writes the typed
 *   domain record (PendingAction), creates its PendingApproval on the host
 *   queue, back-links the two, and drops the Notifications-inbox item.
 * - `decideActionViaApproval()` — the ONE decision path, shared by
 *   `/v1/host/sample/approvals/:id/{claim,reject}` (via the handler hook the
 *   feature registers at boot) and the assistant's own
 *   `/pending-actions/:id/{approve,reject}` routes: the CAS-guarded
 *   `resolveApproval` IS the decision; the PendingAction status is a
 *   projection of it. Execution on approve lands in T6 (runStarter + write
 *   scopes) — T4 records the decision only.
 */

import {
  createAssistantActionApproval,
  getApproval,
  resolveApproval,
  attachRunId,
  registerAssistantActionApprovalHandler,
  registerAssistantActionProjector,
  type AssistantActionDecision,
} from '../../host/approvalService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { stripSecretsFromPersisted } from '../../byok/ephemeralRunSecrets.js';
import { actionPolicyOf } from '../../host/governanceService.js';
import type { StartRunDeps } from '../../host/runStarter.js';
import {
  decidePendingAction,
  enqueuePendingAction,
  getPendingAction,
  setPendingActionApproval,
  type PendingAction,
} from './assistantService.js';
import { executeApprovedAction } from './actionExecution.js';
import { ensureChiefOfStaff } from './chiefOfStaff.js';

function summarize(action: PendingAction): string {
  const to = Array.isArray((action.payload as { to?: unknown }).to)
    ? ((action.payload as { to: unknown[] }).to as string[]).join(', ')
    : typeof (action.payload as { to?: unknown }).to === 'string'
      ? String((action.payload as { to: unknown }).to)
      : undefined;
  const draftHead = action.draft.length > 80 ? `${action.draft.slice(0, 77)}…` : action.draft;
  return `${action.kind}: "${draftHead}"${to ? ` → ${to}` : ''}`;
}

/** Enqueue a draft action onto the single approval loop. */
export async function enqueueActionWithApproval(
  tenantId: string,
  input: Parameters<typeof enqueuePendingAction>[1],
): Promise<PendingAction> {
  // ADR 0028 — a 'disabled' kind drafts nothing at all (the most restrictive
  // posture; 'draft-only' still enqueues, it just never executes — T6 seam).
  if ((await actionPolicyOf(tenantId, input.kind)) === 'disabled') {
    throw Object.assign(
      new Error(`assistant action kind '${input.kind}' is disabled by workspace policy`),
      { code: 'forbidden', status: 403 },
    );
  }
  const action = await enqueuePendingAction(tenantId, input);
  // ADR 0023 (corrected) — attribute the approval to the REAL Chief-of-Staff
  // roster member, so it appears in the roster's "Waiting on me" lane as the
  // agent itself, not a phantom `rosterId:'assistant'`.
  const cos = await ensureChiefOfStaff(tenantId);
  const approval = await createAssistantActionApproval({
    tenantId,
    actionId: action.actionId,
    proposal: summarize(action),
    rosterId: cos.rosterId,
    persona: cos.persona,
  });
  await setPendingActionApproval(tenantId, action.actionId, approval.approvalId);
  // Notifications (ADR 0010) — the inbox/bell is how the principal learns
  // something waits on them. Best-effort, like every notification emit.
  try {
    await getNotificationEmitter().emit({
      tenantId,
      type: 'workflow.approval_needed',
      priority: action.derivedFromUntrusted || action.riskLevel === 'high' ? 'high' : 'normal',
      title: 'The assistant drafted an action for your approval',
      // notify.ts discipline: draft text may derive from untrusted connected
      // content (and free text can embed leaked credentials) — redact before
      // it is persisted + Web-Pushed.
      message: sanitizeFreeText(summarize(action)),
      actionUrl: '/inbox',
      metadata: stripSecretsFromPersisted({ actionId: action.actionId, approvalId: approval.approvalId, kind: action.kind }),
    });
  } catch {
    /* best-effort */
  }
  return { ...action, approvalId: approval.approvalId };
}

/** Decide an assistant action THROUGH its approval act. Returns null when the
 *  approval/action is missing, `changed:false` when a concurrent decision won
 *  (the CAS in resolveApproval is the lock — exactly one winner). */
export async function decideActionViaApproval(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string } = {},
): Promise<AssistantActionDecision | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || !approval.actionId) return null;
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, action: null, changed: false };
  const action = await decidePendingAction(tenantId, approval.actionId, {
    status: outcome,
    ...(opts.decidedByUserId !== undefined ? { approvedByUserId: opts.decidedByUserId } : {}),
  });

  // §12 T6 — the winning APPROVE claim is the single dispatch site (the CAS
  // above is the exactly-once guarantee). Execution rides runStarter under
  // the approving human's identity; deps are bound at boot. Pre-T6 hosts
  // (no deps registered) keep the record-only posture.
  if (outcome === 'approved' && execDeps) {
    const row = await getPendingAction(tenantId, approval.actionId);
    if (row) {
      const runId = await executeApprovedAction(execDeps, tenantId, row, opts.decidedByUserId);
      if (runId) await attachRunId(approvalId, runId);
      const after = await getPendingAction(tenantId, approval.actionId);
      return { approval: lock.approval, action: (after ?? action) as Record<string, unknown> | null, changed: true };
    }
  }
  return { approval: lock.approval, action: action as Record<string, unknown> | null, changed: true };
}

let execDeps: StartRunDeps | null = null;

/** Host-shaped projection of a PendingAction for the approvals inbox ActionCard
 *  — the card fields only, internal columns (tenantId, createdBy) projected out.
 *  This is the ONE place the action's card shape is defined; the inbox consumes
 *  it verbatim. */
function projectActionCard(a: PendingAction): Record<string, unknown> {
  // Allowlist the payload to ONLY what the card renders (the destination), so a
  // future action kind that stuffs sensitive data into `payload` can never leak
  // it onto the approval row by default — additive opt-in, not pass-through.
  const to = (a.payload as { to?: unknown }).to;
  const payload = Array.isArray(to) || typeof to === 'string' ? { to } : {};
  return {
    actionId: a.actionId,
    kind: a.kind,
    draft: a.draft,
    status: a.status,
    payload,
    ...(a.riskLevel !== undefined ? { riskLevel: a.riskLevel } : {}),
    ...(a.requiredScopes !== undefined ? { requiredScopes: a.requiredScopes } : {}),
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    ...(a.sourceRefs !== undefined ? { sourceRefs: a.sourceRefs } : {}),
    ...(a.recipientDiff !== undefined ? { recipientDiff: a.recipientDiff } : {}),
    ...(a.derivedFromUntrusted !== undefined ? { derivedFromUntrusted: a.derivedFromUntrusted } : {}),
    ...(a.editedAt !== undefined ? { editedAt: a.editedAt } : {}),
  };
}

/** Boot hook — lets the core approvals routes decide assistant actions
 *  without importing the feature (direction: feature → core only), binds the
 *  runStarter deps the T6 execution dispatch needs, and registers the projector
 *  the approvals LIST route uses to embed each action's card metadata. */
export function registerAssistantActionApproval(deps?: StartRunDeps): void {
  if (deps) execDeps = deps;
  registerAssistantActionApprovalHandler(decideActionViaApproval);
  registerAssistantActionProjector(async (tenantId, actionId) => {
    const action = await getPendingAction(tenantId, actionId);
    return action ? projectActionCard(action) : null;
  });
}
