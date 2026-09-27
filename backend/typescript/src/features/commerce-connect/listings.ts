/**
 * Commerce Connect — paid listings, lanes + the operator approval gate, and the
 * marketplace pricing provider (ADR 0385 Phases 2/4; CC-6 split). BOTH paid
 * lanes are approval-gated (grade-pass CC-2); only the free lane ships ungated.
 */
import { OpenwopError } from '../../types.js';
import { paidListings, sellers, nowIso, type PaidListing, type ListingLane } from './stores.js';
import { listingTombstones, listingState, platformRegion, assertFoldEligibleTenant, type ListingState } from './stores.js';
import { hasPaidOrder } from './orders.js';
import {
  createCommerceListingApproval,
  findPendingCommerceListingApproval,
  resolveApproval,
  setApprovalProposal,
} from '../../host/approvalService.js';

/** The material fingerprint of a listing — the fields an operator reviews. A
 *  re-submitted identical change reuses the pending approval; any change here
 *  supersedes it (chat-first-port F3). */
export function listingMaterialVersion(l: Pick<PaidListing, 'lane' | 'priceMajorUnits' | 'currency' | 'externalPaymentUrl'>): string {
  return JSON.stringify([l.lane, l.priceMajorUnits ?? null, l.currency ?? null, l.externalPaymentUrl ?? null]);
}

/**
 * ADR 0385 (chat-first-port F3) — keep the shared `commerce-listing-publish`
 * approval row in lockstep with a listing whose `approvalState` is `pending`. The
 * approval row (not the private `approvalState`) is the review item the operator
 * inbox + card decide; the listing's `approvalState` is the seller-facing mirror
 * the handler flips on decide. Deterministic: at most ONE pending approval per
 * pack; an identical re-submit reuses it, a material edit rejects the stale row
 * (superseded) and queues a fresh one. Called after every upsert.
 */
/**
 * The human-readable one-liner every approval surface shows — the generic
 * ApprovalsInbox, the `/reviews` card, and the SLA reminder.
 *
 * UX_UPGRADE-access-data R2 (CC2-B1) — it names the SELLER and, on the
 * external-link lane, the DESTINATION. This gate exists (CLAUDE.md) to stop a
 * multi-tenant phishing/squat listing, and it used to carry lane + price only:
 * an operator approving `feature.crm.nodes (external-link)` could not see that
 * the money link pointed at `stripe-checkout-verify.example`, nor that the
 * submitter was not the pack's author. On that lane the destination IS the
 * decision. One owner, because two call sites now build it.
 */
function listingProposal(listing: PaidListing): string {
  return [
    `Approve marketplace listing "${listing.packName}" (${listing.lane}`,
    listing.priceMajorUnits !== undefined ? `, ${listing.priceMajorUnits} ${listing.currency ?? ''}`.trimEnd() : '',
    ')',
    ` — seller ${listing.sellerTenantId}`,
    listing.externalPaymentUrl ? `, pays out via ${listing.externalPaymentUrl}` : '',
  ].join('');
}

export async function syncCommerceListingApproval(listing: PaidListing): Promise<void> {
  const existing = await findPendingCommerceListingApproval(listing.sellerTenantId, listing.packName);
  if (listing.approvalState !== 'pending') {
    // No review needed (free lane, or unchanged-already-approved). A lingering
    // pending row would orphan → resolve it as superseded.
    if (existing) await resolveApproval(existing.approvalId, { status: 'rejected', note: 'Superseded — listing no longer awaiting review.', chainOutcome: 'superseded' });
    return;
  }
  const version = listingMaterialVersion(listing);
  const proposal = listingProposal(listing);
  if (existing) {
    if (existing.commerceListing?.version === version) {
      // Identical MATERIAL — reuse the row rather than churning the queue.
      // CC2-R1: but `version` hashes lane+price+currency+url, NOT the proposal,
      // so a row queued before the CC2-B1 enrichment would keep its old
      // seller-less, destination-less summary forever unless the seller happened
      // to make a material edit. That is precisely the generic-inbox lane the
      // enrichment exists for. Refresh the text in place when it has drifted;
      // the material — and therefore the approve-what-you-see version check —
      // is untouched.
      if (existing.proposal !== proposal) await setApprovalProposal(existing.approvalId, proposal);
      return;
    }
    await resolveApproval(existing.approvalId, { status: 'rejected', note: 'Superseded by a newer listing edit.', chainOutcome: 'superseded' });
  }
  await createCommerceListingApproval({
    sellerTenantId: listing.sellerTenantId,
    packName: listing.packName,
    lane: listing.lane,
    version,
    proposal,
  });
}


/** Seller-scoped upsert of a listing's pricing lane (the Phase-4 editor's
 *  service; exposed now because purchase needs priced rows). Native-paid rows
 *  enter at `pending` approval unless already approved — approval itself is a
 *  SEPARATE superadmin action, never the seller's. */
export async function upsertPaidListing(
  sellerTenantId: string,
  input: { packName: string; lane: ListingLane; priceMajorUnits?: number; currency?: string; externalPaymentUrl?: string },
): Promise<PaidListing> {
  // MPL-1 / WF-MKT-13 — the GEN-CC-1 fold guard, lane 2 of 4. FIRST, before any
  // read: a listing row is tenant-indexed on `sellerTenantId` AND queues a
  // `commerce-listing-publish` approval row stored under the same tenant, so an
  // anon seller strands BOTH. The route's seller-account precondition does not
  // cover this — it is scoped to `lane === 'native-paid'`, leaving `free` and
  // `external-link` (the arbitrary-payout-URL lane) entirely open.
  assertFoldEligibleTenant(sellerTenantId, 'list a pack on the marketplace');
  const existing = await paidListings.get(input.packName);
  if (existing && existing.sellerTenantId !== sellerTenantId && listingState(existing) !== 'tombstoned') {
    // ADR 0574 — the 409 now names the escalation path that EXISTS (CC2-M2's
    // lesson): the operator approvals inbox reviews listing disputes.
    throw new OpenwopError('validation_error', 'This pack is already listed by another seller. If you are the pack\'s publisher, ask the operator to review the listing (operator approvals inbox).', 409, { packName: input.packName });
  }
  // ADR 0574 P1 — the same-seller re-claim cooldown: a seller whose listing
  // was operator-dissolved cannot immediately re-squat the name. The audit row
  // survives re-claims (the listing row itself gets overwritten).
  const tomb = await listingTombstones.get(input.packName);
  if (tomb && tomb.sellerTenantId === sellerTenantId) {
    const ageMs = Date.now() - Date.parse(tomb.at);
    if (ageMs < TOMBSTONE_COOLDOWN_MS) {
      throw new OpenwopError('forbidden', 'This listing was dissolved by the operator; the name cannot be re-claimed by the same seller during the cooldown.', 403, { packName: input.packName, reason: 'listing_tombstoned_cooldown' });
    }
  }
  if (input.lane === 'native-paid' && (!(input.priceMajorUnits! > 0) || !input.currency)) {
    throw new OpenwopError('validation_error', 'A native-paid listing needs a positive price and a currency.', 400, {});
  }
  if (input.lane === 'external-link' && !/^https:\/\//.test(input.externalPaymentUrl ?? '')) {
    throw new OpenwopError('validation_error', 'An external-link listing needs an https payment URL.', 400, {});
  }
  const now = nowIso();
  const next: PaidListing = {
    packName: input.packName,
    sellerTenantId,
    lane: input.lane,
    ...(input.priceMajorUnits !== undefined ? { priceMajorUnits: input.priceMajorUnits } : {}),
    ...(input.currency ? { currency: input.currency.toLowerCase() } : {}),
    ...(input.externalPaymentUrl ? { externalPaymentUrl: input.externalPaymentUrl } : {}),
    // Approval survives edits ONLY while the material fields are unchanged; any
    // material change re-enters the queue. Grade pass CC-2 (ADR 0385 correction):
    // the EXTERNAL-LINK lane is approval-gated too — in a multi-tenant host an
    // unreviewed listing pointing an arbitrary https URL at other tenants is a
    // phishing/name-squat vector the Notion single-vendor model never had. Only
    // the free lane ships ungated.
    ...(input.lane !== 'free'
      ? {
          approvalState:
            existing?.lane === input.lane && existing.approvalState === 'approved'
              && existing.priceMajorUnits === input.priceMajorUnits
              && existing.currency === input.currency?.toLowerCase()
              && existing.externalPaymentUrl === input.externalPaymentUrl
              ? 'approved' as const : 'pending' as const,
        }
      : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await paidListings.put(next);
  // Keep the shared approval row in lockstep (create / reuse / supersede) — the
  // operator inbox + card decide THAT row, not this private mirror.
  await syncCommerceListingApproval(next);
  return next;
}


/** Operator approval decision (the listing mirror flip). Called ONLY by the
 *  commerce-connect approval handler after the shared `commerce-listing-publish`
 *  row is CAS-resolved (chat-first-port F3) — no longer a bespoke route decision.
 *  Separation of duties (the approver is never the seller) is enforced by the
 *  handler's superadmin gate. */
export async function setListingApproval(packName: string, decision: 'approved' | 'rejected', note?: string): Promise<PaidListing> {
  const listing = await paidListings.get(packName);
  if (!listing || listing.lane === 'free') {
    throw new OpenwopError('not_found', 'No approval-gated listing under that pack name.', 404, { packName });
  }
  // MKT-UX-7 — mirror the operator's REASON onto the listing. A seller cannot
  // read approval rows; `/seller/listings` is their only window, and until now
  // it carried the single word "Rejected" with no reason, no date and no exit.
  // `note` is cleared on a re-decide so a stale reason can never survive onto a
  // later, differently-decided listing.
  const now = nowIso();
  const next: PaidListing = {
    ...listing,
    approvalState: decision,
    ...(note ? { approvalNote: note } : { approvalNote: undefined }),
    approvalDecidedAt: now,
    updatedAt: now,
  };
  await paidListings.put(next);
  return next;
}


export async function getPaidListing(packName: string): Promise<PaidListing | null> {
  return paidListings.get(packName);
}


/** Browse-visible paid listings: everything but unapproved native-paid rows
 *  (those are visible to their own seller + operators only). */
export async function listPaidListings(viewerTenantId?: string): Promise<PaidListing[]> {
  const all = await paidListings.list();
  // CC-2: BOTH paid lanes are approval-gated; unapproved rows are visible only
  // to their own seller (+ operators via the queue).
  //
  // MPL-16 — the LIFECYCLE gate, which two other readers of this same store
  // already applied and this one did not. `listingPricingFor` drops any row whose
  // `listingState(l) !== 'active'` and `createCheckout` refuses one, but this
  // filtered on APPROVAL alone — so `GET …/commerce-connect/listings` returned
  // suspended and tombstoned rows to every viewer as if they were purchasable.
  // Latent only because that route had no caller (MPL-10); a disagreement between
  // two readers of one store is a defect whether or not it is currently reachable.
  // The row's own SELLER still sees it via `/seller/listings` (ADR 0574 P3's
  // "visible to the seller, never purchasable, not a 404").
  return all
    .filter((l) => listingState(l) === 'active')
    .filter((l) => l.lane === 'free' || l.approvalState === 'approved' || l.sellerTenantId === viewerTenantId);
}


/**
 * MPL-6 / MKT-UX-17 — the seller's own RELEASE, the exit that did not exist.
 *
 * `upsertPaidListing` refuses a second seller for a pack name, and for
 * `lane:'free'` it sets no `approvalState`, so `syncCommerceListingApproval`
 * creates NO approval row. Net effect: a `PUT …/listings/<any pack> {lane:'free'}`
 * was an INVISIBLE, PERMANENT claim on the name — the real publisher got a 409
 * forever, no operator ever saw it queued, and there was no seller-side delete
 * (only the superadmin `dissolveListing`, which imposes a 90-day cooldown and is
 * the wrong instrument for "I no longer want to list this").
 *
 * This is the second of the two cures the audit sanctioned, and deliberately not
 * the first. Gating the CLAIM would have to refuse a listing for a pack this host
 * cannot see — and absence is ambiguous here for exactly the reason `orders.ts`
 * spells out at its own tombstone gate: `listListings()` rescans a directory that
 * is legitimately empty in valid configurations, so refusing on absence would take
 * legitimate listings down whenever the pack directory is briefly unreadable.
 * Making the claim REVERSIBLE has no such failure mode.
 *
 * NOT a tombstone: a voluntary release must not impose the operator-dissolution
 * cooldown on the seller who released it. Any pending approval is resolved as
 * superseded, so the operator queue does not keep a card for a listing that no
 * longer exists.
 */
export async function releaseOwnListing(sellerTenantId: string, packName: string): Promise<void> {
  const l = await paidListings.get(packName);
  // 404, not 403, when it belongs to someone else: a seller must not be able to
  // probe which pack names another workspace has claimed.
  if (!l || l.sellerTenantId !== sellerTenantId) {
    throw new OpenwopError('not_found', 'You have no listing under that pack name.', 404, { packName });
  }
  // An operator-dissolved listing is NOT the seller's to release — releasing it
  // would delete the row the 90-day cooldown check reads against.
  if (listingState(l) === 'tombstoned') {
    throw new OpenwopError('conflict', 'This listing was dissolved by the operator and cannot be released by the seller.', 409, { packName });
  }
  const pending = await findPendingCommerceListingApproval(sellerTenantId, packName);
  if (pending) await resolveApproval(pending.approvalId, { status: 'rejected', note: 'Superseded — the seller released this listing.' });
  await paidListings.delete(packName);
}


/** A seller's own listings (any lane/approval state) — bounded tenant read. */
export async function listOwnListings(sellerTenantId: string): Promise<PaidListing[]> {
  return (await paidListings.listForTenantIndexed(sellerTenantId)).sort((a, b) => a.packName.localeCompare(b.packName));
}


/** The marketplace pricing-provider (ADR 0385 P4) — annotates a page of
 *  listings for one viewer tenant. Bounded point lookups (one listing get per
 *  named pack that HAS a paid row; one seller get + one order get for
 *  native-paid rows). Enrichment only — purchase gates stay in createCheckout. */
/** ADR 0574 P1 — 90 days: long enough that squat-dissolve-resquat is not a
 *  strategy, short enough that a legitimately-corrected seller returns. */
const TOMBSTONE_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

/** ADR 0574 P1 — operator dissolution. Tombstones (never hard-deletes): the
 *  row keeps its audit trail and the durable tombstone row carries the
 *  cooldown. Cross-instance by construction — listing state is a per-request
 *  store read, not a boot cache. Idempotent. */
export async function dissolveListing(packName: string, by: string, reason: string): Promise<void> {
  const l = await paidListings.get(packName);
  if (!l) throw new OpenwopError('not_found', 'No listing under that pack name.', 404, { packName });
  const at = new Date().toISOString();
  await paidListings.put({ ...l, state: 'tombstoned', stateMeta: { by, at, reason }, updatedAt: at });
  await listingTombstones.put({ packName, sellerTenantId: l.sellerTenantId, by, at, reason });
}

/** ADR 0574 P3 — operator hold / release. `suspended` is visible to the seller
 *  and never purchasable; `active` releases. Tombstoning goes through
 *  `dissolveListing` (it writes the cooldown row), never through here. */
export async function setListingState(packName: string, state: Exclude<ListingState, 'tombstoned'>, by: string, reason: string): Promise<void> {
  const l = await paidListings.get(packName);
  if (!l) throw new OpenwopError('not_found', 'No listing under that pack name.', 404, { packName });
  const at = new Date().toISOString();
  await paidListings.put({ ...l, state, ...(state === 'active' ? { stateMeta: undefined } : { stateMeta: { by, at, reason } }), updatedAt: at });
}

export async function listingPricingFor(packNames: string[], viewerTenantId: string): Promise<Record<string, {
  lane: ListingLane; priceMajorUnits?: number; currency?: string; externalPaymentUrl?: string; purchasable?: boolean; purchased?: boolean;
}>> {
  const out: Record<string, { lane: ListingLane; priceMajorUnits?: number; currency?: string; externalPaymentUrl?: string; purchasable?: boolean; purchased?: boolean }> = {};
  // Grade-pass CC-5: the per-pack point lookups run CONCURRENTLY (a marketplace
  // page annotates dozens of listings — serial awaits made this an N-roundtrip
  // waterfall on the browse hot path). Each pack is still ≤3 point gets.
  const rows = await Promise.all(packNames.map(async (packName) => {
    const l = await paidListings.get(packName);
    if (!l || l.lane === 'free') return null;
    // ADR 0574 P3 — a non-active listing is not annotated onto browse at all
    // (tombstoned = dissolved; suspended = operator hold). The seller still
    // sees their own row via /seller/listings.
    if (listingState(l) !== 'active') return null;
    if (l.lane === 'external-link') {
      // CC-2: an unreviewed external payment URL is never annotated onto the
      // marketplace browse surface (phishing vector) — approved rows only.
      if (l.approvalState !== 'approved') return null;
      return { packName, pricing: { lane: l.lane, ...(l.externalPaymentUrl ? { externalPaymentUrl: l.externalPaymentUrl } : {}) } };
    }
    // native-paid: visible pricing only once approved (unapproved rows are the
    // seller's draft state, not a public price).
    if (l.approvalState !== 'approved') return null;
    const [seller, purchased] = await Promise.all([sellers.get(l.sellerTenantId), hasPaidOrder(viewerTenantId, packName)]);
    return {
      packName,
      pricing: {
        lane: l.lane,
        ...(l.priceMajorUnits !== undefined ? { priceMajorUnits: l.priceMajorUnits } : {}),
        ...(l.currency ? { currency: l.currency } : {}),
        purchased,
        // ONE predicate (ADR 0574 P3, folding CC2-M4): the projection now
        // includes the REGION guard checkout enforces, so the UI never renders
        // a Buy that checkout will 409.
        purchasable: !purchased
          && l.sellerTenantId !== viewerTenantId
          && !!seller && seller.onboardingState === 'enabled' && seller.chargesEnabled
          && (!seller.region || seller.region === platformRegion()),
      },
    };
  }));
  for (const row of rows) if (row) out[row.packName] = row.pricing;
  return out;
}
