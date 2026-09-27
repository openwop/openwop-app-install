/**
 * Strategy check-in approval handler (CHAT-FIRST-PORT-AUDIT D3) — the decide side
 * of the agent-proposed check-in gate, the ADR 0230 `activationApproval.ts` /
 * ADR 0066 `contentApproval.ts` pattern.
 *
 * An agent-origin check-in lands `proposed` (ADR 0231) and `appendCheckIn` raises
 * a `kind: 'strategy-checkin'` PendingApproval alongside it. A human resolves it
 * from the SAME reviews inbox every other proposal uses (approve ⇒ CONFIRM the
 * check-in; reject ⇒ DISMISS it) OR from the strategy page (whose confirm/dismiss
 * route now delegates to THIS same resolution — one durable decision record).
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerStrategyCheckInApprovalHandler`); this feature registers at boot.
 * Authority: `workspace:write` in the strategy's org — the SAME bar the check-in
 * confirm/dismiss route enforced (`loadStrategyScoped(req, true)`), applied HERE
 * because the generic approvals route is tenant-scoped and cannot apply it.
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../host/approvalDecision.ts — the single decision core
 * @see ./activationApproval.ts — the sibling strategy gate this mirrors
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerStrategyCheckInApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { getStrategy, subjectHasOrgScope } from './strategyService.js';
import { decideCheckIn } from './checkIns.js';

/**
 * Resolve a strategy check-in approval: enforce write authority + IDOR, flip the
 * approval (CAS), then confirm (`approved`) or dismiss (`rejected`) the check-in.
 * Returns null when the approval is missing/cross-tenant, not a check-in gate, or
 * the strategy/check-in vanished (the route maps that to 404). Throws
 * `forbidden_scope` (403) when the decider lacks `workspace:write` in the org.
 */
async function decideStrategyCheckIn(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'strategy-checkin' || !approval.strategyCheckIn) return null;

  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }
  const strategyId = approval.strategyId ?? '';
  const { checkInId } = approval.strategyCheckIn;

  // IDOR + write authority (the SAME bar the confirm/dismiss route enforced).
  const s = await getStrategy(tenantId, strategyId);
  if (!s) return null; // strategy deleted between propose and decide → 404
  const canWrite = s.scope === 'user'
    ? decidedBy === s.createdBy
    : await subjectHasOrgScope(tenantId, decidedBy, s.orgId, 'workspace:write');
  if (!canWrite) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }

  // CAS flip pending→resolved; `changed` gates the effect so a losing concurrent
  // decide neither double-confirms nor double-dismisses. Resolve BEFORE deciding
  // the check-in, then COMPENSATE (re-open) if it can't be applied — the ADR 0066
  // HIGH-1 lesson: a failed decide never consumes the approval.
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  const checkInOutcome = outcome === 'approved' ? 'confirmed' : 'dismissed';
  try {
    const decided = await decideCheckIn(tenantId, strategyId, checkInId, checkInOutcome, decidedBy);
    if (!decided) {
      await reopenApproval(approvalId);
      return null; // check-in deleted between queue and decide → 404 (approval stays pending)
    }
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  return { approval: lock.approval, changed: true };
}

/** Register the strategy check-in decision handler on the core approvals hook
 *  (called from the strategy feature at boot). */
export function registerStrategyCheckInGate(): void {
  registerStrategyCheckInApprovalHandler(decideStrategyCheckIn);
}
