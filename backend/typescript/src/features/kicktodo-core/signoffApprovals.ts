/**
 * Code-grade KTY-1 (2026-10-14) — one registration for the four KickTodo sign-off
 * approval kinds (`community-profile`, `community-review`, `metrics-verifier-sample`,
 * `connect-seller`). Each owning feature calls this at boot with its decision
 * handler; it registers:
 *
 *  - the HANDLER the generic decision lane dispatches to (approvalDecision.ts
 *    KIND_DISPATCH), so approve and reject from the inbox, the approvals routes and
 *    decide-by-email act on the feature's own state; and
 *  - the decider ELIGIBILITY check (KTFULL-B2, the challenge-publish precedent):
 *    the decider must hold `host:kicktodo:manage` and must not be any of the
 *    subjects the kind names as interested parties (separation of duties).
 *
 * Before this, none of the four had either, so any identified tenant member could
 * reject one, and nobody could approve one from the inbox.
 */
import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  registerApprovalEligibility,
  registerKicktodoSignoffApprovalHandler,
  type KicktodoSignoffApprovalHandler,
  type KicktodoSignoffKind,
  type PendingApproval,
} from '../../host/approvalService.js';
import { hasKicktodoManageAuthority } from '../featureRoute.js';

export function registerKicktodoSignoffApprovals(
  kind: KicktodoSignoffKind,
  handler: KicktodoSignoffApprovalHandler,
  opts: { separateFrom: (approval: PendingApproval) => Array<string | undefined> },
): void {
  registerKicktodoSignoffApprovalHandler(kind, handler);
  registerApprovalEligibility(kind, async (tenantId, decidedBy, approval) => {
    if (!decidedBy || !(await hasKicktodoManageAuthority(tenantId, decidedBy))) {
      throw new OpenwopError('forbidden_scope', 'Deciding this KickTodo approval requires KickTodo manage authority.', 403, { requiredScope: 'host:kicktodo:manage' });
    }
    if (opts.separateFrom(approval).some((subject) => subject !== undefined && subject !== '' && subject === decidedBy)) {
      throw new OpenwopError('forbidden', 'This KickTodo approval must be decided by someone other than the people it concerns (separation of duties).', 403, {});
    }
  });
}

/**
 * The decision handler for a sign-off whose decision IS the record the feature reads
 * back (`metrics-verifier-sample`: the grade is the approval status that
 * `verifierQuality` counts; `connect-seller`: `sellerRequestStatus` reads it). It only
 * CAS-resolves the approval, after confirming the tenant and kind.
 */
export function resolveOnlySignoffHandler(kind: KicktodoSignoffKind): KicktodoSignoffApprovalHandler {
  return async (tenantId, approvalId, outcome, opts) => {
    const approval = await getApproval(approvalId);
    if (!approval || approval.tenantId !== tenantId || approval.kind !== kind) return null;
    if (approval.status !== 'pending') return { approval, changed: false };
    if (!opts.decidedByUserId) throw new OpenwopError('forbidden', 'Deciding this KickTodo approval requires an identified approver.', 403, {});
    return resolveApproval(approvalId, { status: outcome, decidedBy: opts.decidedByUserId, ...(opts.note !== undefined ? { note: opts.note } : {}) });
  };
}
