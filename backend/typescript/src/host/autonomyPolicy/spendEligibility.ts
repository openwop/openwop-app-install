/**
 * ADR 0942 D5 / D10.2 — decide-time eligibility for an autonomy-gated
 * `campaign-spend` row.
 *
 * `evaluateQuorum` finalizes a single-approver row without reading its
 * `approverRoleRefs`, so before this check a spend row that NAMED its approvers was
 * decidable by any `approvals:respond` holder. When the row carries policy approver
 * refs (written only by the autonomy chokepoint), the decider must be eligible on
 * the row's client org (the one ADR 0075 authority, `isEligibleApprover`), and may
 * not be one of the run's requesters, in either direction. A requester who wants to
 * stop the spend cancels the run.
 *
 * > CORRECTED 2026-11-19: the one exception is the sole-admin self-approval ADR (D1,
 * > v0.15.0): a requester who is the only admin able to decide may APPROVE, checked
 * > below via `soleAdminSelfApproval`. A reject by a requester is still refused.
 *
 * > CORRECTED 2026-11-20 (ADR 1022 CP71WF-23, user decision 2026-11-20): "a
 * > requester who wants to stop the spend cancels the run" has no run to cancel for
 * > an ADR 0952 reallocation plan proposed from the Campaign Intelligence route or
 * > the Analyst's chat tool, so a mistaken plan sat for its 7-day TTL. One more
 * > narrow exception: on a `campaign-spend` row whose `spendKind` is
 * > `'reallocation'`, a requester may REJECT (withdraw) when they are a person
 * > voting in their own interactive session (`isInteractivePersonVote`, never the
 * > wildcard operator lane, a delegated key, an agent or an MCP principal). The
 * > precedent is ADR 1024 D3.4 (`approvalService.ts`, "separation of duties binds
 * > approve only; a submitter may withdraw") and the agent-deployments requester
 * > withdraw. Approve is unchanged; every other campaign-spend row (launch,
 * > budget, publish, audience) still refuses a requester's reject. The plan
 * > records the withdrawal (`status: 'withdrawn'`, `withdrawnBy`, `withdrawnAt`,
 * > `campaign-intel/reallocation.ts`).
 *
 * Rows WITHOUT policy approver refs (the pre-0942 governance threshold, any
 * non-campaign spend) keep today's behaviour: no check here.
 */
import { OpenwopError } from '../../types.js';
import { registerApprovalEligibility, type ApprovalEligibilityCheck, type PendingApproval } from '../approvalService.js';
import { isEligibleApprover } from '../approverResolution.js';
import { canonicalDecider } from '../delegatedSubject.js';
import type { Storage } from '../../storage/storage.js';
import { isAutonomyRequester, isInteractivePersonVote, soleAdminSelfApproval } from './selfApproval.js';
import { policyApproverRefs } from '../approverResolution.js';
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

/** A requester's reject that is a withdrawal of their own reallocation plan (see the
 *  2026-11-20 correction above). An absent `outcome` is the stricter `approved`. */
function reallocationWithdraw(approval: PendingApproval, voter: string, opts: Parameters<ApprovalEligibilityCheck>[3]): boolean {
  return approval.kind === 'campaign-spend'
    && approval.spendKind === 'reallocation'
    && opts?.outcome === 'rejected'
    && opts.isOperator !== true
    && isInteractivePersonVote(voter, opts.humanSession === true);
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
    const voterId: string = decidedBy;
    const decider = (await canonicalDecider(tenantId, voterId)) ?? voterId;
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
    // Runs the escape must clear (their MCP / attended-fork floors). An unreadable
    // waiter can never be cleared, so it pins the refusal.
    const matchedRuns: Array<NonNullable<typeof source>> = source && requested ? [source] : [];
    let unreadableWaiter = false;
    for (const runId of await approvalWaiterRunIds(tenantId, approval.approvalId)) {
      if (runId === approval.autonomySourceRunId) continue;
      const waiting = await storage.getRun(runId);
      if (!waiting || waiting.tenantId !== tenantId) { requested = true; unreadableWaiter = true; continue; }
      if (await isAutonomyRequester(waiting, voters)) { requested = true; matchedRuns.push(waiting); }
    }
    const submitters = [...(approval.submitters ?? []), ...(approval.submitterCauses ?? [])];
    for (const requester of submitters) {
      if (await isAutonomyRequester({ tenantId, metadata: { actingUserId: requester } }, voters)) requested = true;
    }
    // the sole-admin self-approval ADR (D1) — approving only; a reject by a requester keeps today's refusal.
    if (requested && !unreadableWaiter && opts?.outcome === 'approved') {
      const verdict = await soleAdminSelfApproval({
        tenantId, ...(approval.orgId ? { orgId: approval.orgId } : {}), gateId: approval.approvalId, voter: voterId,
        // Threaded from the decide route's auth Subject (`decidedByHumanSession`).
        humanSession: opts.humanSession === true && opts.isOperator !== true,
        runs: matchedRuns, submitters, refs: policyApproverRefs(policy),
        quorum: (policy?.requiredApprovals ?? 1) > 1, surface: approval.kind ?? 'approval',
      });
      if (verdict.allowed) requested = false;
    }
    // ADR 1022 CP71WF-23 (corrected 2026-11-20) — the reallocation proposer may
    // withdraw their own plan. Not an approver decision, so the approver-role check
    // below does not apply: the proposer needs no approver role to take it back.
    if (requested && !unreadableWaiter && reallocationWithdraw(approval, voterId, opts)) return;
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
