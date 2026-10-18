/**
 * Author payout-onboarding requests (ADR 0445 P2/D2).
 *
 * The seller lanes are APPROVAL-GATED (the CLAUDE.md multi-tenant phishing/
 * squat posture): an author with something to be paid for asks; the operator
 * decides on the SHARED approval queue (`connect-seller` kind — the ADR 0438
 * Safety inbox renders it; no parallel queue). The Connect account itself
 * stays the tenant's ONE seller row via the EXISTING commerce-connect lane —
 * this service never mints a second seller model (P2 /architect correction:
 * Connect sellers are per-tenant; the approval is per (tenant, author)).
 *
 * GEN-CC-1 mirror: an `anon:` tenant can never request — refused at the door.
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import {
  createConnectSellerApproval,
  getApproval,
} from '../../host/approvalService.js';
import { getSeller } from '../commerce-connect/connectService.js';
import { revenueProjectionFor } from './entitlementService.js';

const log = createLogger('kicktodo.seller-request');

export interface SellerRequest {
  tenantId: string;
  authorSubject: string;
  approvalId: string;
  createdAt: string;
  /** grade-code #6 — resolved approvals are PRUNED (capped per tenant), so the
   *  last status observed from the approval is stamped here; without it an
   *  approved author would read as never-requested after pruning. */
  lastStatus?: 'pending' | 'approved' | 'rejected';
}

const requests = new DurableCollection<SellerRequest>(
  'kicktodo-seller-requests',
  (r) => `${r.tenantId}::${r.authorSubject}`,
);

const nowIso = (): string => new Date().toISOString();

export class SellerRequestError extends Error {
  constructor(message: string, readonly code: 'forbidden' | 'nothing-to-pay' | 'conflict') {
    super(message);
  }
}

export interface SellerRequestStatus {
  /** `none` = never requested; otherwise the approval's current state. */
  request: 'none' | 'pending' | 'approved' | 'rejected';
  /** The tenant's Connect seller state (null until onboarding starts) — the
   *  honest "when do I actually get paid" read. */
  seller: { onboardingState: string; payoutsEnabled: boolean } | null;
}

const SELLER_REQUEST_CAS_ATTEMPTS = 8;

/** KTM-3 — the approval id a request mints, DERIVED from what it supersedes: the
 *  (tenant, author) pair plus the approval id of the request row it replaces (none
 *  for a first request, the rejected one for a re-request). Every concurrent caller
 *  that read the same row derives the same id, so they create ONE approval between
 *  them; a later re-request reads a different row and gets a fresh id. */
function sellerApprovalIdFor(tenantId: string, author: string, supersedes: string | undefined): string {
  const h = createHash('sha256').update(`${tenantId}::${author}::${supersedes ?? ''}`).digest('hex').slice(0, 32);
  return `appr:kt-seller:${h}`;
}

/** Request payout onboarding. Idempotent: an existing pending/approved request
 *  is returned as-is; a REJECTED one may be re-requested (a fresh approval —
 *  operators can change their mind).
 *
 *  KTCOM-5 / KTM-3 — concurrent requests mint ONE approval. This used to read the
 *  row, create an approval with a random id, then blind-`put` the row, so two
 *  concurrent requests both saw "none" and put two cards in the operator's inbox
 *  (approving the orphan one did nothing). The approval id is now derived from
 *  the row the caller read (`sellerApprovalIdFor`) and created insert-if-absent,
 *  and the row is swapped against that read. A loser re-reads and returns the
 *  winner's row. A crash between the two writes is repaired by the next request,
 *  which derives the same id and adopts the approval it already made. */
export async function requestSellerOnboarding(tenantId: string, author: string): Promise<SellerRequest> {
  if (tenantId.startsWith('anon:')) {
    throw new SellerRequestError('Sign in to request payouts — anonymous sessions cannot become sellers.', 'forbidden');
  }
  // Something to be paid FOR: at least one product link of the author's own.
  const links = await revenueProjectionFor(tenantId, author);
  if (links.length === 0) {
    throw new SellerRequestError('Link a challenge to a product first — payouts need something that sells.', 'nothing-to-pay');
  }

  for (let attempt = 0; attempt < SELLER_REQUEST_CAS_ATTEMPTS; attempt++) {
    const existing = await requests.get(`${tenantId}::${author}`);
    if (existing) {
      const approval = await getApproval(existing.approvalId);
      const status = approval && approval.tenantId === tenantId ? approval.status : existing.lastStatus;
      if (status && status !== 'rejected') return existing; // pruned-but-approved stays settled
    }

    const approval = await createConnectSellerApproval({
      tenantId,
      submittedBy: author,
      proposal: `KickTodo author requests payout onboarding (${links.length} linked product${links.length === 1 ? '' : 's'}).`,
      approvalId: sellerApprovalIdFor(tenantId, author, existing?.approvalId),
    });
    const row: SellerRequest = { tenantId, authorSubject: author, approvalId: approval.approvalId, createdAt: nowIso() };
    if (await requests.compareAndSwap(existing, row)) {
      log.info('kicktodo_seller_requested', { tenantId, approvalId: approval.approvalId });
      return row;
    }
  }
  throw new SellerRequestError('Your payout request is being updated concurrently — retry.', 'conflict');
}

/** The author's OWN request + the tenant's seller state (self-scoped read). */
export async function sellerRequestStatus(tenantId: string, author: string): Promise<SellerRequestStatus> {
  const row = await requests.get(`${tenantId}::${author}`);
  let request: SellerRequestStatus['request'] = 'none';
  if (row) {
    const approval = await getApproval(row.approvalId);
    if (approval && approval.tenantId === tenantId) {
      request = approval.status;
      // Stamp the observed status so the read survives approval pruning.
      // KTM-3 — swap, never put: a blind put of this (possibly stale) row could
      // overwrite a concurrent re-request's new approval id. A lost swap just
      // skips the stamp; the next read stamps again.
      if (row.lastStatus !== approval.status) await requests.compareAndSwap(row, { ...row, lastStatus: approval.status });
    } else {
      request = row.lastStatus ?? 'pending'; // pruned ⇒ the last observed truth
    }
  }
  const seller = await getSeller(tenantId);
  return {
    request,
    seller: seller ? { onboardingState: seller.onboardingState, payoutsEnabled: seller.payoutsEnabled } : null,
  };
}
