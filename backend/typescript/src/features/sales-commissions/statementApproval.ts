/**
 * Commission-statement approval handler (CFP-1 / D9) — the DECIDE side of the
 * statement approval gate, the `environments/promotionApproval.ts` pattern.
 *
 * Approving a commission statement commits what a rep is owed (payout-affecting).
 * Before this, it was a bespoke `<button onClick={POST …/approve}>` on
 * `CommissionsPage` — a naked mutation paralleling the shared HITL/reviews
 * machinery (the D9 port map's BLOCKER 3 / row 14). Now a manager SUBMITS a draft
 * for approval, which queues a `kind: 'commission-statement'` PendingApproval on the
 * shared reviews inbox; a second manager claims/rejects it there, and THIS handler
 * applies the `draft → approved` transition behind the org's `host:commissions:manage`
 * bar.
 *
 * Money invariant (ADR 0280 §8): the statement row IS the payout record; the host
 * moves NO money. Obligation-ledger accrual (ADR 0447) is DEFERRED — see the D9
 * port map BLOCKER 4: it needs a major→minor currency-exponent conversion that is a
 * separate money-precision change, and the statement row already satisfies the
 * money invariant. `mark-paid` (approved→paid) stays an operational settle on the
 * already-gated statement (not a bespoke decision).
 *
 * @see ../../host/approvalService.ts / approvalDecision.ts — queue + decision core
 * @see ../../../docs/chat-first-port/d9-field-sales.md — the port map (row 14)
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerCommissionStatementApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { approveStatement, getStatementRaw, sameSubject, findDealConflicts, releaseStatementClaims } from './entities/statement.js';
import { pinMatches } from './pin.js';
import { formatStatementTotal } from './proposalText.js';
import { commissionMutated } from './emit.js';

/** The note a review card is closed with when its statement's deals were already paid on
 *  another statement of the plan (ADR 1034 D4). The statements list reads it back to tell
 *  the console to offer Recompute, so it is one constant, not a string matched by prefix. */
export const DEAL_CONFLICT_NOTE = 'Superseded: some deals on this statement are already on an approved statement of this plan. Recompute it so they are left off.';

async function decideCommissionStatement(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'commission-statement' || !approval.commissionStatement || !approval.orgId) {
    return null;
  }
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide a statement.', 403, {});
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId: approval.orgId });
  if (!(access.scopes as readonly string[]).includes('host:commissions:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:commissions:manage', 403, { requiredScope: 'host:commissions:manage' });
  }

  const pin = approval.commissionStatement;
  const { statementId, total: pinnedTotal, currency: pinnedCurrency } = pin;
  const live = await getStatementRaw(tenantId, approval.orgId, statementId);
  if (!live) {
    // R2 COM2-M5 — the statement is GONE (its plan was deleted, which cascades drafts).
    // Leaving the card pending made it unclearable: the CAS flips it, `approveStatement`
    // 404s, the catch reopens it, and every retry repeats — approve is impossible and
    // only reject escapes, by rejecting something that no longer exists. Resolve it as
    // rejected with a reason instead, the `rejectPendingApprovalForPage` precedent.
    const closed = await resolveApproval(approvalId, { status: 'rejected', note: 'The statement no longer exists (its plan was deleted).', ...(decidedBy ? { decidedBy } : {}) });
    // Review I8 — throwing unconditionally reported FAILURE for a reject that succeeded:
    // the operator asked to reject, the card closed as rejected, and the UI showed an
    // error. A reject of a vanished statement is exactly what the operator wanted.
    if (outcome === 'rejected') return closed ? { approval: closed.approval, changed: closed.changed } : null;
    throw new OpenwopError('not_found', 'This statement no longer exists, so it cannot be approved. The review has been closed.', 404, { statementId });
  }

  // R2 COM2-B4 — APPROVE WHAT YOU SEE. The card froze `{total, currency}` at submit and
  // baked them into the proposal text, and this handler read only the statement ID — so a
  // recompute between submit and decide meant the reviewer approved a figure they never
  // saw. The app already has this pin (`reviewProjection.ts`: "lets the card detect edits
  // … and send the hash it displayed back with the approve", with a 409 `proposal_stale`);
  // this surface simply never used it, on the one card that authorises a payment.
  //
  // ADR 1034 D5 — the pin now also covers the attainment and the lines (`pin.ts`), so a
  // change to what DROVE the total is stale too, not only a change to the total.
  if (outcome === 'approved' && !pinMatches(pin, live)) {
    throw new OpenwopError('conflict', `This statement changed after it was submitted (it now reads ${formatStatementTotal(live.total, live.currency)}, the review card says ${formatStatementTotal(pinnedTotal, pinnedCurrency)}${live.total === pinnedTotal ? ', and what it was computed from changed' : ''}). Re-submit it so the approver sees what they are approving.`, 409, {
      statementId, pinned: { total: pinnedTotal, currency: pinnedCurrency }, live: { total: live.total, currency: live.currency },
    });
  }

  // R2 COM2-M4 — SELF-PAYOUT is refused unconditionally: nobody approves money paid to
  // themselves, and there is no tenant shape in which that is legitimate.
  //
  // The other half of separation of duties — submitter ≠ approver, which this file's
  // docblock promises ("a second manager claims/rejects it there") — is NOT enforced
  // here, deliberately. MEASURED: enforcing it reddened two existing tests, and the
  // reason both went red is that the only approval path in a single-admin workspace IS
  // submit-then-approve by the same person. A correct-looking gate that leaves a solo
  // operator unable to ever approve a statement is a bigger defect than the one it
  // closes, and choosing that trade is the operator's call, not mine. What this pass
  // does is make the fact RECORDABLE: `submittedBy` is now on the row, so an operator
  // who wants the rule can enforce it, and an auditor can see when one person did both.
  // ADR 1034 D8 — matched across subject spellings (a raw `===` let a deal `owner` stored
  // as `user:<id>` approve its own payout as `<id>`).
  if (outcome === 'approved' && sameSubject(live.subjectId, decidedBy)) {
    throw new OpenwopError('forbidden_scope', 'You cannot approve your own commission statement.', 403, { statementId });
  }

  // ADR 1034 D4 — a deal another statement of this plan already committed can never pass.
  // Checked BEFORE the approval CAS, so the card is closed as superseded instead of being
  // reopened by the compensation path below into a card no approve can ever clear (the
  // COM2-M5 dead end, architect B4). A race that slips past this is caught again inside
  // `approveStatement`, and the reopened card's next attempt lands here.
  if (outcome === 'approved') {
    const conflicts = await findDealConflicts(live);
    if (conflicts.length > 0) {
      await resolveApproval(approvalId, { status: 'rejected', note: DEAL_CONFLICT_NOTE, decidedBy });
      await releaseStatementClaims(tenantId, statementId);
      throw new OpenwopError('conflict', `${conflicts.length} deal(s) on this statement were already paid on another statement of the same plan. The review has been closed; recompute the statement and submit it again.`, 409, {
        reason: 'deal_already_committed', statementId, deals: conflicts.slice(0, 20),
      });
    }
  }

  // Resolve-before-apply (CAS-gated side effect + compensation, ADR 0066 HIGH-1).
  const lock = await resolveApproval(approvalId, { status: outcome, ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}), ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  // A reject leaves the statement draft — no approval, no accrual. ADR 1034 D4: it also
  // frees any deal claims an earlier failed approval attempt left bound to it, so a
  // rejected statement does not keep its deals from another statement of the plan.
  if (outcome === 'rejected') {
    if (live.status === 'draft') await releaseStatementClaims(tenantId, statementId);
    return { approval: lock.approval, changed: true };
  }

  try {
    // ADR 1034 D4 (architect B3) — approve EXACTLY the row the pin was checked against.
    const stmt = await approveStatement(tenantId, approval.orgId, statementId, decidedBy, live);
    commissionMutated({ entity: 'statement', verb: 'approved', tenantId, orgId: approval.orgId, actor: decidedBy, entityId: stmt.statementId });
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  return { approval: lock.approval, changed: true };
}

/** Register the commission-statement decision handler on the core approvals hook
 *  (called from the sales-commissions feature at boot). */
export function registerCommissionStatementGate(): void {
  registerCommissionStatementApprovalHandler(decideCommissionStatement);
}
