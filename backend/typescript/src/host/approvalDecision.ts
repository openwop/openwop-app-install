/**
 * Approval decision core (ADR 0068 §Phase 3) — the single owner of "what a
 * claim/reject DOES".
 *
 * The claim/reject decision (handler dispatch for content-publish + assistant
 * actions, run-start + kanban for run-proposals, CAS finality, audit) used to
 * live inline in `routes/approvals.ts`. ADR 0068 adds a SECOND caller — the
 * unified `/reviews/:reviewId/actions/:action` surface — so the logic is
 * extracted here and BOTH routes call it. There is exactly one decision path;
 * the projection route never re-implements it (single-source-of-truth).
 *
 * Behavior is byte-for-byte the existing route behavior; the approvals route
 * tests are the regression guard.
 *
 * @see routes/approvals.ts — the original inbox routes (now thin callers)
 * @see host/reviewProjection.ts — the unified review surface (the new caller)
 */

import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from './index.js';
import type { Storage } from '../storage/storage.js';
import { getRosterEntry } from './rosterService.js';
import { getBoard, moveCard, setCardLastRun, notifyBoardChanged } from './kanbanService.js';
import { startWorkflowRun } from './runStarter.js';
import { resolveEffectiveAccess } from './accessControlService.js';
import { isEligibleApprover } from './approverResolution.js';
import { appendDecision, tallyDecisions, evaluateQuorumTally } from './reviewDecisionLedger.js';
import { emitReviewUpdatedSignal } from '../notifications/notify.js';
import {
  getApproval,
  resolveApproval,
  attachRunId,
  getAssistantActionApprovalHandler,
  getContentApprovalHandler,
  type PendingApproval,
} from './approvalService.js';

export interface ApprovalDecisionDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

export interface ApprovalDecisionCtx {
  tenantId: string;
  /** The deciding user/principal id (for audit + handler attribution). */
  decidedBy?: string;
  /** Optional reviewer note captured at decision time. */
  note?: string;
}

export interface ApprovalDecisionResult {
  approvalId: string;
  /** `pending` (ADR 0070) ⇒ a quorum vote was recorded but the gate is not yet
   *  resolved; `policy` carries the progress. */
  status: 'approved' | 'rejected' | 'pending';
  runId?: string;
  pageId?: string;
  actionId?: string;
  approval?: PendingApproval;
  /** Quorum progress, present when the approval carries a multi-approver policy. */
  policy?: { requiredApprovals: number; approvals: number; rejections: number };
}

/**
 * Multi-approver gate (ADR 0070) — for an approval whose `policy.requiredApprovals
 * > 1`, each claim/reject is an eligibility-checked VOTE recorded in the durable
 * `review:decision` ledger (keyed by approvalId). Returns `finalize` only when
 * THIS outcome's threshold is met — so the caller's existing single-decision
 * finalize (run start / reject) runs exactly once, gated by the same CAS. Absent
 * policy ⇒ `finalize` immediately (the legacy path is byte-unchanged).
 */
async function evaluateQuorum(
  ctx: ApprovalDecisionCtx,
  approval: PendingApproval,
  outcome: 'approved' | 'rejected',
): Promise<{ decision: 'finalize' } | { decision: 'pending'; progress: { requiredApprovals: number; approvals: number; rejections: number } }> {
  const required = approval.policy && approval.policy.requiredApprovals > 1 ? approval.policy.requiredApprovals : 0;
  if (required === 0) return { decision: 'finalize' }; // not a quorum approval — unchanged

  // Identity is the authenticated caller — never anonymous for a quorum vote.
  const reviewerRef = ctx.decidedBy;
  if (!reviewerRef) throw new OpenwopError('forbidden', 'A quorum approval requires an authenticated approver.', 403, { approvalId: approval.approvalId });

  // Eligibility: an explicit approver list, else the approvals:respond scope.
  // INTENTIONAL DIVERGENCE from the runtime-interrupt path
  // (`routes/interrupts.ts` `assertEligibleApprover`): there an EMPTY approver
  // list is an OPEN gate (the `openwop-interrupt-quorum` conformance contract
  // requires it). HERE, an empty list still requires the `approvals:respond`
  // scope — pre-execution approvals start runs / publish pages (higher stakes),
  // are NOT on the RFC 0093 token wire, and have no conformance obligation, so
  // they stay default-secure. Do NOT "unify" these two without re-checking the
  // quorum conformance scenario.
  // ADR 0075 §D1/§D2 — resolve the gate's approver refs (explicit subjects ∪
  // group members ∪ role holders) through the single resolver, live + org-scoped.
  // A non-open gate admits ONLY the resolved subjects; an open gate (no refs of
  // any kind) keeps this surface's default-secure `approvals:respond` requirement
  // (the INTENTIONAL divergence from the interrupt path documented above).
  const { eligible, openGate } = await isEligibleApprover(
    reviewerRef,
    {
      ...(approval.policy?.approverRefs ? { approverRefs: approval.policy.approverRefs } : {}),
      ...(approval.policy?.approverGroupRefs ? { approverGroupRefs: approval.policy.approverGroupRefs } : {}),
      ...(approval.policy?.approverRoleRefs ? { approverRoleRefs: approval.policy.approverRoleRefs } : {}),
    },
    { tenantId: ctx.tenantId, ...(approval.orgId ? { orgId: approval.orgId } : {}) },
  );
  if (!openGate) {
    if (!eligible) throw new OpenwopError('forbidden', 'You are not an eligible approver for this gate.', 403, { approvalId: approval.approvalId });
  } else {
    const access = await resolveEffectiveAccess(ctx.tenantId, { subject: reviewerRef, ...(approval.orgId ? { orgId: approval.orgId } : {}) });
    if (!(access.scopes as readonly string[]).includes('approvals:respond')) {
      throw new OpenwopError('forbidden', 'Approving this gate requires the approvals:respond scope.', 403, { approvalId: approval.approvalId });
    }
  }

  // Record (dedup per reviewer) + tally the durable ledger.
  await appendDecision({ gateId: approval.approvalId, reviewerRef, outcome, ...(ctx.note ? { reason: ctx.note } : {}), decidedAt: new Date().toISOString() });
  const tally = await tallyDecisions(approval.approvalId);
  const progress = { requiredApprovals: required, approvals: tally.accepts.length, rejections: tally.rejects.length };

  // Single source of truth for the threshold + rejection math (ADR 0070), shared
  // with the runtime-interrupt path. Finalize only when THIS vote's outcome is the
  // one the tally now resolves to (a claim never starts the run on a reject-won
  // gate, and vice-versa).
  const verdict = evaluateQuorumTally(tally, {
    requiredApprovals: required,
    rejectionPolicy: approval.policy?.rejectionPolicy === 'majority' ? 'majority' : 'any',
  });
  if ((outcome === 'approved' && verdict === 'accept') || (outcome === 'rejected' && verdict === 'reject')) {
    return { decision: 'finalize' };
  }
  return { decision: 'pending', progress };
}

/** Fetch + tenant-guard a pending approval, or throw the canonical error. Shared
 *  by both decision verbs so the not-found / already-resolved mapping is uniform. */
async function loadPending(tenantId: string, approvalId: string): Promise<PendingApproval> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId });
  }
  if (approval.status !== 'pending') {
    throw new OpenwopError('conflict', `Approval already ${approval.status}.`, 409, { status: approval.status });
  }
  return approval;
}

function auditDecision(deps: ApprovalDecisionDeps, ctx: ApprovalDecisionCtx, action: string, resource: string, payload: Record<string, unknown>): void {
  void deps.storage
    .appendAudit({
      timestamp: new Date().toISOString(),
      principalId: ctx.decidedBy ?? 'unknown',
      action,
      resource,
      outcome: 'success',
      payload,
    })
    .catch(() => {});
}

/** ADR 0074 — broadcast a `review.updated` cache hint after an approval decision
 *  (or quorum vote) so every live review surface (chat card, Reviews tab, inbox)
 *  reconciles regardless of which surface/client decided it. The reviewId mirrors
 *  the ADR 0068 projection (`approval:${approvalId}`). Best-effort + non-persisted. */
function announceReview(tenantId: string, result: ApprovalDecisionResult): ApprovalDecisionResult {
  emitReviewUpdatedSignal({
    tenantId,
    reviewId: `approval:${result.approvalId}`,
    status: result.status,
    approvalId: result.approvalId,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.policy ? { policy: result.policy } : {}),
  });
  return result;
}

/**
 * Claim (affirmatively decide) a pending approval. Branches by kind exactly as
 * the original route did:
 *  - content-publish → CMS handler (publishes the page, enforces org RBAC + IDOR);
 *  - assistant-action → assistant handler (marks the typed PendingAction);
 *  - run-proposal     → resolve-before-dispatch CAS, then start the run + kanban.
 * Throws OpenwopError (404/409/422) on the same conditions as before.
 */
export async function claimApproval(
  deps: ApprovalDecisionDeps,
  ctx: ApprovalDecisionCtx,
  approvalId: string,
): Promise<ApprovalDecisionResult> {
  const { tenantId, decidedBy, note } = ctx;
  const approval = await loadPending(tenantId, approvalId);

  // ADR 0070 — multi-approver gate: a claim is a VOTE. Until quorum is met the
  // approval stays pending (no handler dispatch / run start); only the vote that
  // meets quorum falls through to the single-decision finalize below.
  const quorum = await evaluateQuorum(ctx, approval, 'approved');
  if (quorum.decision === 'pending') {
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'pending', policy: quorum.progress });
  }

  // ADR 0066 — content-publish: the claim IS the approve (CMS handler).
  if (approval.kind === 'content-publish') {
    const handler = getContentApprovalHandler();
    if (!handler) throw new OpenwopError('conflict', 'CMS feature is not composed on this host.', 409, {});
    const decided = await handler(tenantId, approval.approvalId, 'approved', {
      ...(decidedBy ? { decidedByUserId: decidedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
    auditDecision(deps, ctx, 'cms.page.published', `cms-page:${approval.pageId}`, { approvalId: approval.approvalId, tenantId, orgId: approval.orgId });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved', pageId: approval.pageId });
  }

  // ADR 0023 §12 T4 — assistant-action: the claim marks the typed PendingAction.
  if (approval.actionId) {
    const handler = getAssistantActionApprovalHandler();
    if (!handler) throw new OpenwopError('conflict', 'Assistant feature is not composed on this host.', 409, {});
    const decided = await handler(tenantId, approval.approvalId, 'approved', {
      ...(decidedBy ? { decidedByUserId: decidedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
    auditDecision(deps, ctx, 'assistant.action.approved', `assistant-action:${approval.actionId}`, { approvalId: approval.approvalId, tenantId });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved', actionId: approval.actionId });
  }

  // run-proposal: confirm the proposing member still exists before acting.
  const entry = await getRosterEntry(approval.rosterId);
  if (!entry || entry.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Proposing agent no longer exists.', 404, { rosterId: approval.rosterId });
  }
  // Pre-resolve the proposed workflow BEFORE locking, so a vanished workflow
  // fails cleanly (422) instead of leaving an approved-but-unrun approval.
  const wf = await deps.hostSuite.workflowCatalog.getWorkflow(approval.workflowId);
  if (!wf) {
    throw new OpenwopError('workflow_not_found', 'Proposed workflow no longer resolves.', 422, { workflowId: approval.workflowId });
  }
  // Resolve-before-dispatch: flip pending→approved FIRST; `changed` is the lock.
  // Only the winning claim dispatches — a concurrent claim sees changed:false.
  const lock = await resolveApproval(approval.approvalId, { status: 'approved', ...(note !== undefined ? { note } : {}) });
  if (!lock) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
  if (!lock.changed) throw new OpenwopError('conflict', `Approval already ${lock.approval.status}.`, 409, { status: lock.approval.status });

  const runId = await startWorkflowRun(deps, {
    tenantId,
    workflowId: approval.workflowId,
    metadata: {
      approval: {
        rosterId: entry.rosterId,
        persona: entry.persona,
        agentId: entry.agentRef.agentId,
        boardId: approval.boardId,
        cardId: approval.cardId,
        approvalId: approval.approvalId,
        source: 'approval',
      },
    },
  });
  if (!runId) {
    throw new OpenwopError('workflow_not_found', 'Proposed workflow no longer resolves.', 422, { workflowId: approval.workflowId });
  }
  await attachRunId(approval.approvalId, runId);

  // Best-effort: move the picked card to Working (the run has started).
  if (approval.boardId && approval.cardId) {
    await setCardLastRun(approval.cardId, runId);
    const board = await getBoard(approval.boardId);
    const working = board?.columns.find((c) => c.id === 'working' || c.name.toLowerCase() === 'working');
    if (working) await moveCard(approval.cardId, working.id);
    notifyBoardChanged(approval.boardId);
  }

  return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved', runId });
}

/**
 * Reject (dismiss) a pending approval. Mirrors `claimApproval`'s branching:
 * handler dispatch for content-publish / assistant-action; for a run-proposal,
 * park the board card terminally then CAS-resolve to rejected.
 */
export async function rejectApproval(
  deps: ApprovalDecisionDeps,
  ctx: ApprovalDecisionCtx,
  approvalId: string,
): Promise<ApprovalDecisionResult> {
  const { tenantId, decidedBy, note } = ctx;
  const approval = await loadPending(tenantId, approvalId);

  // ADR 0070 — multi-approver gate: a reject is a VOTE; the gate only fails once
  // the rejection policy is met.
  const quorum = await evaluateQuorum(ctx, approval, 'rejected');
  if (quorum.decision === 'pending') {
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'pending', policy: quorum.progress });
  }

  if (approval.kind === 'content-publish') {
    const handler = getContentApprovalHandler();
    if (!handler) throw new OpenwopError('conflict', 'CMS feature is not composed on this host.', 409, {});
    const decided = await handler(tenantId, approval.approvalId, 'rejected', {
      ...(decidedBy ? { decidedByUserId: decidedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
    auditDecision(deps, ctx, 'cms.page.rejected', `cms-page:${approval.pageId}`, { approvalId: approval.approvalId, tenantId, orgId: approval.orgId });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected', pageId: approval.pageId });
  }

  if (approval.actionId) {
    const handler = getAssistantActionApprovalHandler();
    if (!handler) throw new OpenwopError('conflict', 'Assistant feature is not composed on this host.', 409, {});
    const decided = await handler(tenantId, approval.approvalId, 'rejected', {
      ...(decidedBy ? { decidedByUserId: decidedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
    auditDecision(deps, ctx, 'assistant.action.rejected', `assistant-action:${approval.actionId}`, { approvalId: approval.approvalId, tenantId });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected', actionId: approval.actionId });
  }

  // Park the card terminally (best-effort) so it leaves the To Do pick path.
  if (approval.boardId && approval.cardId) {
    const board = await getBoard(approval.boardId);
    const terminal = board?.columns[board.columns.length - 1];
    if (terminal) await moveCard(approval.cardId, terminal.id);
    notifyBoardChanged(approval.boardId);
  }

  const resolved = await resolveApproval(approval.approvalId, { status: 'rejected', ...(note !== undefined ? { note } : {}) });
  if (!resolved?.changed) {
    throw new OpenwopError('conflict', 'Approval already resolved.', 409, { approvalId: approval.approvalId });
  }
  return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected', approval: resolved.approval });
}
