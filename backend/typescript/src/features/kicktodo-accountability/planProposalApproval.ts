/**
 * KickTodo coach plan-proposal approval handler (ADR 0459 P2).
 *
 * The decide side of the participant-facing plan-proposal card: a coach's
 * proposal is raised as a `kind: 'kicktodo-plan-proposal'` PendingApproval; the
 * PARTICIPANT resolves it from the circle conversation or their reviews rail,
 * and the core decide path (approvalDecision.ts) calls THIS handler.
 *
 * The handler is a THIN delegate to `resolveProposal`, which stays the ONE
 * plan-applier:
 *  - its enrollment-owner check is the AUTHORITY — it throws CircleDeniedError
 *    for ANY non-owner (including the coach), which we map to the same uniform
 *    404 the rest of this surface uses (indistinguishable from absent);
 *  - it is idempotent, so a proposal already resolved via the retained
 *    per-enrollment route (or a concurrent claim) is a no-op success here.
 *
 * Ordering is deliberate: `resolveProposal` runs FIRST (authority + apply/dismiss)
 * so a denied non-owner never consumes the approval; only then do we CAS-flip the
 * approval to match. `resolveProposal`'s idempotency makes a retry after a crash
 * between the two steps converge (it never re-applies).
 *
 * Direction: feature → core only (core owns the hook; this feature registers the
 * handler at boot — the content-publish / contact-merge discipline).
 */
import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  registerPlanProposalApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveProposal } from './cohortService.js';
import { CircleDeniedError } from './circleService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.kicktodo.planProposalApproval');

async function decidePlanProposal(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'kicktodo-plan-proposal' || !approval.planProposal) {
    return null;
  }
  if (!opts.decidedByUserId) {
    throw new OpenwopError('forbidden_scope', 'A signed-in participant is required to decide a plan proposal.', 403, {});
  }
  const { enrollmentId, proposalId } = approval.planProposal;

  // AUTHORITY + apply/dismiss FIRST — resolveProposal denies any non-owner before
  // the approval is touched. Map its uniform CircleDeniedError to the same 404 the
  // rest of the kicktodo surface uses (indistinguishable from absent).
  try {
    await resolveProposal(tenantId, enrollmentId, proposalId, opts.decidedByUserId, outcome === 'approved' ? 'apply' : 'dismiss');
  } catch (err) {
    if (err instanceof CircleDeniedError) {
      throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId });
    }
    throw err;
  }

  // Now flip the approval to match (idempotent CAS; `changed` gates the inbox row
  // + audit exactly once). A lost race here is a no-op success upstream (409),
  // and resolveProposal above has already converged the proposal state.
  const flip = await resolveApproval(approvalId, { status: outcome, ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}), ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!flip) return null;
  return { approval: flip.approval, changed: flip.changed };
}

/** Register the plan-proposal approval handler at boot (called from the feature). */
export function registerKicktodoAccountabilityApprovalHandler(): void {
  registerPlanProposalApprovalHandler(decidePlanProposal);
  log.debug('kicktodo_plan_proposal_handler_registered');
}
