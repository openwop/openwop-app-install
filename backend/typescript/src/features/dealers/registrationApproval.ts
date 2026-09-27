/**
 * Dealer deal-registration approval handler (CFP-1 / D9) — the DECIDE side of the
 * partner deal-registration gate, the `environments/promotionApproval.ts` pattern.
 *
 * Before this, a partner-submitted registration was approved/rejected by a bespoke
 * `<button onClick={POST …/approve}>` on `DealersPage` — a naked mutation that
 * PARALLELED the shared HITL/reviews machinery (the D9 port map's BLOCKER 3). Now a
 * pending registration queues a `kind: 'dealer-registration'` PendingApproval on the
 * SAME reviews inbox every other proposal uses; a manager claims/rejects it there,
 * and THIS handler applies the flip (`decideRegistration`) behind the org's
 * `host:dealers:manage` bar.
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerDealerRegistrationApprovalHandler`); this feature registers at boot.
 * Authority: `host:dealers:manage` at the approval's ORG scope — the SAME bar the
 * old decision route enforced, reused here (the generic approvals route is
 * tenant-scoped and does not apply the dealers write bar itself).
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../host/approvalDecision.ts — the single decision core
 * @see ../../../docs/chat-first-port/d9-field-sales.md — the port map (row 12)
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerDealerRegistrationApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { decideRegistration } from './entities/registration.js';
import { dealerMutated } from './emit.js';

async function decideDealerRegistration(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'dealer-registration' || !approval.dealerRegistration || !approval.orgId) {
    return null;
  }
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide a registration.', 403, {});
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId: approval.orgId });
  if (!(access.scopes as readonly string[]).includes('host:dealers:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:dealers:manage', 403, { requiredScope: 'host:dealers:manage' });
  }

  // Resolve-before-apply (the ADR 0066 HIGH-1 compensation lesson): flip
  // pending→resolved via CAS FIRST so a losing concurrent decide neither
  // double-applies nor double-rejects; then apply the registration flip and
  // COMPENSATE (reopen) if it can't happen — a failed decide never consumes the
  // approval, and the row never claims "approved" while the registration stayed put.
  const lock = await resolveApproval(approvalId, { status: outcome, ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}), ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };
  try {
    const reg = await decideRegistration(tenantId, approval.orgId, approval.dealerRegistration.regId, outcome, decidedBy, 'approval');
    dealerMutated({ entity: 'registration', verb: outcome, tenantId, orgId: approval.orgId, actor: decidedBy, entityId: reg.regId });
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  return { approval: lock.approval, changed: true };
}

/** Register the dealer-registration decision handler on the core approvals hook
 *  (called from the dealers feature at boot). */
export function registerDealerRegistrationGate(): void {
  registerDealerRegistrationApprovalHandler(decideDealerRegistration);
}
