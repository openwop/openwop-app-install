/**
 * CMS content-publish approval handler (ADR 0066).
 *
 * The decide side of the interrupt-backed editorial gate. When the
 * `cms-approval-gate` toggle is ON, submitting a page for review queues a
 * `kind: 'content-publish'` PendingApproval (host/approvalService.ts). A
 * reviewer resolves it from the SAME ApprovalsInbox the assistant/run proposals
 * use; the core approvals routes call this handler for content-publish rows so
 * the inbox claim/reject path and the CMS publish flow share ONE
 * implementation.
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerContentApprovalHandler`); the CMS feature registers this at boot.
 * Authority is unchanged from the direct routes — `host:members:manage` in the
 * page's org — and is enforced HERE (the generic approvals route is tenant-
 * scoped; content approval adds the org + role dimension + IDOR).
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../../docs/adr/0066-cms-interrupt-backed-editorial-approval.md
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerContentApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { getOrg, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { transitionPage } from './cmsService.js';

/**
 * Resolve a content-publish approval: enforce org RBAC + IDOR, flip the approval
 * (CAS), then transition the page (`approve` → published, `reject` → draft).
 * Returns null when the approval is missing/cross-tenant or not a content
 * approval (the route maps that to 404). Throws `forbidden_scope` (403) when the
 * decider lacks `host:members:manage` in the page's org.
 */
async function decideContentPublish(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'content-publish') return null;

  const orgId = approval.orgId ?? '';
  const pageId = approval.pageId ?? '';
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }

  // IDOR + org-role authority (mirrors `requireOrgScope(req, 'host:members:manage')`,
  // which the generic approvals route cannot apply — it is tenant-scoped).
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) {
    // Uniform not-found: never leak a cross-tenant/org approval's existence.
    return null;
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
  if (!access.scopes.includes('host:members:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, {
      requiredScope: 'host:members:manage',
    });
  }

  // CAS flip pending→resolved; `changed` gates the page transition so a losing
  // concurrent decide neither double-publishes nor double-rejects (only the CAS
  // winner transitions). We resolve BEFORE transitioning to keep that gate, then
  // COMPENSATE (re-open) if the transition can't happen — so a failed decide
  // never consumes the approval, and the row never claims "approved" while the
  // page stayed unpublished (review finding HIGH-1 / LOW-4).
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  // Single owner of the status transition — the existing publish path (snapshots
  // the published version). `from:['in_review']` THROWS 409 for a stale page;
  // a deleted page returns null. Either way, restore the approval to pending.
  let page;
  try {
    page = await transitionPage(tenantId, orgId, pageId, outcome === 'approved' ? 'approve' : 'reject', decidedBy);
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  if (!page) {
    await reopenApproval(approvalId);
    return null; // page deleted between submit and decide → 404 (approval stays pending)
  }
  return { approval: lock.approval, changed: true };
}

/** Register the content-publish decision handler on the core approvals hook
 *  (called from the CMS feature at boot). */
export function registerContentApprovalGate(): void {
  registerContentApprovalHandler(decideContentPublish);
}
