/**
 * ADR 1024 D3.4/D3.5 — who may decide a `warehouse-load` approval.
 *
 * Before ADR 1024 nobody could: the kind fell through to the run-proposal finalizer,
 * which 404'd on the row's empty `rosterId`. And had it worked, the audience was the whole
 * tenant with no check, so the member who asked for a load could approve their own export
 * of customer data to a warehouse (`CDP2WF-6`).
 *
 * The rule (lead decision Q3 = a):
 *  - the decider holds `workspace:write` in the tenant;
 *  - on APPROVE, the decider is not one of the row's `submitters` (separation of duties);
 *  - a submitter may REJECT — withdrawing your own load is not a second opinion;
 *  - the wildcard operator, and the owner of a personal workspace (there is no second
 *    person to ask there), are exempt from the separation rule.
 *
 * Registered through the ONE decide choke (`registerApprovalEligibility`), which both
 * decide lanes (`claimApproval`, `rejectApproval`) call with the outcome.
 */
import { registerApprovalEligibility, type ApprovalEligibilityCheck } from '../../host/approvalService.js';
import { assertTenantScope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';

export const warehouseLoadEligibility: ApprovalEligibilityCheck = async (tenantId, decidedBy, approval, opts) => {
  if (opts?.isOperator) return;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'Deciding a warehouse load requires an identified approver.', 403, { approvalId: approval.approvalId });
  }
  if (!opts?.isPersonalOwner) await assertTenantScope(tenantId, decidedBy, 'workspace:write');
  // An absent outcome is a caller that predates the field: treat it as the stricter approve.
  if (opts?.outcome === 'rejected' || opts?.isPersonalOwner) return;
  const deciders = new Set([decidedBy, ...(opts?.spellings ?? [])]);
  if ((approval.submitters ?? []).some((s) => deciders.has(s))) {
    throw new OpenwopError(
      'forbidden_scope',
      'Separation of duties: the person who asked for this warehouse load cannot approve it. Another member with write access must decide.',
      403,
      { approvalId: approval.approvalId, reason: 'separation-of-duties' },
    );
  }
};

export function registerWarehouseLoadEligibility(): void {
  registerApprovalEligibility('warehouse-load', warehouseLoadEligibility);
}
