/**
 * ADR 0942 D5 / D10.2 — decide-time eligibility for an autonomy-gated
 * `campaign-spend` row.
 *
 * `evaluateQuorum` finalizes a single-approver row without reading its
 * `approverRoleRefs`, so before this check a spend row that NAMED its approvers was
 * decidable by any `approvals:respond` holder. When the row carries policy approver
 * refs (written only by the autonomy chokepoint), the decider must be eligible on
 * the row's client org (the one ADR 0075 authority, `isEligibleApprover`), and may
 * not be one of the run's requesters, in either direction, with no sole-approver
 * escape. A requester who wants to stop the spend cancels the run.
 *
 * Rows WITHOUT policy approver refs (the pre-0942 governance threshold, any
 * non-campaign spend) keep today's behaviour: no check here.
 */
import { OpenwopError } from '../../types.js';
import { registerApprovalEligibility } from '../approvalService.js';
import { isEligibleApprover } from '../approverResolution.js';
import { canonicalDecider } from '../delegatedSubject.js';
import type { Storage } from '../../storage/storage.js';
import { isAutonomyRequester } from './selfApproval.js';
import { approvalWaiterRunIds } from './waiters.js';

export function registerAutonomySpendEligibility(storage: Pick<Storage, 'getRun'>): void {
  registerApprovalEligibility('campaign-spend', policyRowEligibility(storage, false));
  registerApprovalEligibility('creative-publish-review', policyRowEligibility(storage, true));
}

/**
 * ADR 0948 P1b × ADR 0942 — the same decide-time eligibility for an approval kind a
 * FEATURE owns (registered at that feature's boot, so the check exists whenever the
 * kind does). A row the autonomy chokepoint stamped with named approvers is
 * decidable only by an eligible non-requester; a row without them keeps the kind's
 * own authority. Never a replacement for the kind's own floor, always in addition.
 */
export function registerAutonomyPolicyRowEligibility(kind: string, storage: Pick<Storage, 'getRun'>): void {
  registerApprovalEligibility(kind, policyRowEligibility(storage, false));
}

function policyRowEligibility(storage: Pick<Storage, 'getRun'>, required: boolean): Parameters<typeof registerApprovalEligibility>[1] {
  return async (tenantId, decidedBy, approval, opts) => {
    const policy = approval.policy;
    const named = (policy?.approverRoleRefs?.length ?? 0) > 0 || (policy?.approverGroupRefs?.length ?? 0) > 0;
    if (!named) {
      if (!required) return;
      throw new OpenwopError('forbidden_scope', 'This review names no approvers.', 403, { reason: 'autonomy_approver_required' });
    }
    if (!decidedBy) {
      throw new OpenwopError('forbidden_scope', 'This spend needs a named approver from the campaign\'s autonomy policy.', 403, { reason: 'autonomy_approver_required' });
    }
    const decider = (await canonicalDecider(tenantId, decidedBy)) ?? decidedBy;
    const mine = new Set([decidedBy, decider, ...(opts?.spellings ?? [])]);
    const source = approval.autonomySourceRunId ? await storage.getRun(approval.autonomySourceRunId) : null;
    // A missing or cross-tenant origin cannot authorize spending. Legacy rows
    // without a run reference still compare BOTH sides through the canonical
    // helper rather than comparing raw/delegated subject spellings by hand.
    if (approval.autonomySourceRunId && (!source || source.tenantId !== tenantId)) {
      throw new OpenwopError('forbidden_scope', 'The requesting run could not be verified.', 403, { reason: 'autonomy_requester_unreadable' });
    }
    const voters = [...mine];
    let requested = source ? await isAutonomyRequester(source, voters) : false;
    for (const runId of await approvalWaiterRunIds(tenantId, approval.approvalId)) {
      if (runId === approval.autonomySourceRunId) continue;
      const waiting = await storage.getRun(runId);
      if (!waiting || waiting.tenantId !== tenantId || await isAutonomyRequester(waiting, voters)) requested = true;
    }
    for (const requester of [...(approval.submitters ?? []), ...(approval.submitterCauses ?? [])]) {
      if (await isAutonomyRequester({ tenantId, metadata: { actingUserId: requester } }, voters)) requested = true;
    }
    if (requested) {
      throw new OpenwopError('forbidden_scope', 'You requested this spend, so someone else has to decide it.', 403, { reason: 'autonomy_self_approval_refused' });
    }
    const refs = {
      ...(policy?.approverRefs ? { approverRefs: policy.approverRefs } : {}),
      ...(policy?.approverGroupRefs ? { approverGroupRefs: policy.approverGroupRefs } : {}),
      ...(policy?.approverRoleRefs ? { approverRoleRefs: policy.approverRoleRefs } : {}),
    };
    const ctx = { tenantId, ...(approval.orgId ? { orgId: approval.orgId } : {}) };
    for (const who of mine) {
      if ((await isEligibleApprover(who, refs, ctx)).eligible) return;
    }
    throw new OpenwopError('forbidden_scope', 'You are not an approver for this spend under the campaign\'s autonomy policy.', 403, { reason: 'autonomy_not_eligible' });
  };
}
