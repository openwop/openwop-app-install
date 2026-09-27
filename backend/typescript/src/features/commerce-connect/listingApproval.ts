/**
 * Commerce Connect listing-publish approval handler (ADR 0385; chat-first-port F3).
 *
 * The decide side of the operator listing gate. When a seller lists (or materially
 * re-prices) a native-paid/external-link pack, `syncCommerceListingApproval`
 * queues a `kind: 'commerce-listing-publish'` PendingApproval (host/approvalService).
 * The operator resolves it from the SAME shared decision core (host/approvalDecision)
 * the reviews inbox uses — via the operator card OR the reviews inbox — so
 * card-decide ≡ inbox-decide (ONE decision path, no bespoke route decision).
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerCommerceListingApprovalHandler`); this feature registers at boot. The
 * authority is HOST-GLOBAL SUPERADMIN (the approver is NEVER the seller — the
 * CLAUDE.md multi-tenant phishing/squat posture): it is computed at the HTTP
 * boundary (`isSuperadmin(req)`) and threaded here as `opts.isSuperadmin`, then
 * RE-ASSERTED in this handler so no non-superadmin decide path can slip through.
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../host/approvalDecision.ts — the single decision core
 * @see ./listings.ts — syncCommerceListingApproval (the submit-side queue)
 * @see docs/adr/0385-commerce-connect-seller-marketplace.md
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerCommerceListingApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { getPaidListing, setListingApproval, listingMaterialVersion } from './listings.js';

/**
 * Resolve a commerce-listing-publish approval: enforce superadmin, flip the
 * approval (CAS), then mirror the decision onto the listing's `approvalState`
 * (`approve`/`reject`). Returns null when the approval is missing/cross-tenant or
 * not a listing approval (the route maps that to 404). Throws `forbidden` (403)
 * when the decider is not a superadmin.
 */
async function decideCommerceListing(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; isSuperadmin?: boolean },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'commerce-listing-publish' || !approval.commerceListing) {
    return null;
  }
  if (!opts.isSuperadmin) {
    throw new OpenwopError('forbidden', 'Only a host superadmin can decide a marketplace listing.', 403, {});
  }

  const packName = approval.commerceListing.packName;
  // On APPROVE, guard against a stale row: if the listing's current material no
  // longer matches the version this approval reviewed, the seller edited it after
  // submitting — a fresh approval exists, so this one must not publish the old
  // shape. (Supersede normally rejects the stale row; this closes the race.)
  if (outcome === 'approved') {
    const current = await getPaidListing(packName);
    if (!current || current.lane === 'free' || listingMaterialVersion(current) !== approval.commerceListing.version) {
      return null; // → 404; a new approval covers the current material
    }
  }

  // CAS flip pending→resolved BEFORE mirroring onto the listing (the CAS gates the
  // side effect); COMPENSATE (re-open) if the mirror flip fails — the ADR 0066
  // discipline, so a failed decide never consumes the approval.
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  // APPR-4 — re-check the material version AFTER the CAS flip: the pre-CAS guard
  // above and the flip are not atomic, so a seller edit landing in that window
  // would otherwise publish the stale shape this approval reviewed. On a mismatch,
  // re-open (never consume the approval) and 404 — a fresh approval covers the
  // current material. This closes the seller-edit TOCTOU window.
  if (outcome === 'approved') {
    const current = await getPaidListing(packName);
    if (!current || current.lane === 'free' || listingMaterialVersion(current) !== approval.commerceListing.version) {
      await reopenApproval(approvalId);
      return null;
    }
  }

  try {
    // MKT-UX-7 — the note reaches the SELLER, not just the audit trail. The core
    // already carried it (`resolveApproval` above); it stopped here.
    await setListingApproval(packName, outcome === 'approved' ? 'approved' : 'rejected', opts.note);
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  return { approval: lock.approval, changed: true };
}

/** Register the commerce-listing decision handler on the core approvals hook
 *  (called from the commerce-connect feature at boot). */
export function registerCommerceListingGate(): void {
  registerCommerceListingApprovalHandler(decideCommerceListing);
}
