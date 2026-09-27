/**
 * CRM contact-merge steward approval handler (ADR 0264 / CDP-B).
 *
 * The decide side of the steward gate: a probabilistic match candidate is proposed
 * as a `kind: 'contact-merge'` PendingApproval; a steward resolves it from the SAME
 * ApprovalsInbox, and the core decide path calls THIS handler. On approve it performs
 * the deterministic `mergeContacts` (never an auto-merge — a human dispositions it).
 *
 * Direction: feature → core only (core owns the hook; the CRM feature registers this
 * at boot — the content-publish discipline, ADR 0066).
 */
import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerContactMergeApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { mergeContacts } from './crmMergeService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.crm.mergeApproval');

async function decideContactMerge(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'contact-merge') return null;
  if (!opts.decidedByUserId) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide a merge.', 403, {});
  }
  // CAS-flip the approval FIRST (gates the side effect); reopen if the merge fails so
  // the row never lies about what happened (mirrors the content-publish compensation).
  const flip = await resolveApproval(approvalId, { status: outcome, ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}), ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!flip) return null;
  if (flip.changed && outcome === 'approved') {
    try {
      await mergeContacts(tenantId, approval.survivorContactId ?? '', approval.sourceContactId ?? '', `steward:${opts.decidedByUserId}`);
    } catch (err) {
      await reopenApproval(approvalId).catch(() => {});
      log.warn('steward merge failed after approval — approval reopened', { approvalId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
  return { approval: flip.approval, changed: flip.changed };
}

/** Register the CRM approval handlers at boot (called from the CRM feature). */
export function registerCrmApprovalHandlers(): void {
  registerContactMergeApprovalHandler(decideContactMerge);
}
