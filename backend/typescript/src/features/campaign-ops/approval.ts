/**
 * ADR 0924 P0 — version-bound approval of a change set, on the ONE approvals
 * queue (kind `campaign-change-set`).
 *
 * An approval names one change-set hash and the source versions it was built
 * against, and authorizes only that. Checks run BEFORE the pending→resolved CAS
 * (nothing is consumed by a refusal):
 *   1. the hash the decider saw = the row's = the stored change set's (else 409
 *      `change_set_mismatch`, the row stays pending);
 *   2. the request is still at that version (else the row is closed, the change
 *      set goes stale, 409 `request_changed`);
 *   3. every asset still reads at its source version and hash (else closed,
 *      stale, 409 `asset_changed` naming the assets — a newer human edit);
 *   4. the client is active;
 *   5. separation of duties: the person who caused the proposal cannot approve it;
 *   6. the decider holds `approvals:respond` on the CLIENT org (the `agency`
 *      policy, D4).
 * After the CAS it starts the execution run with the approved hash pinned; if
 * that start fails the row is reopened.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { hasDistinctScopeHolder, resolveEffectiveAccess } from '../../host/accessControlService.js';
import {
  createChangeSetApprovalOnce,
  getApproval,
  registerCampaignChangeSetApprovalHandler,
  reopenApproval,
  resolveApproval,
  type PendingApproval,
} from '../../host/approvalService.js';
import { appendAudit } from '../../host/auditChainService.js';
import { createLogger } from '../../observability/logger.js';
import { adapterFor } from './adapters/registry.js';
import { getAsset } from './assetService.js';
import { getChangeSet, transitionChangeSet } from './changeSetService.js';
import { getClient } from './clientService.js';
import { getRequest } from './requestService.js';
import type { ChangeSet } from './types.js';

const log = createLogger('features.campaign-ops.approval');

export const changeSetApprovalIdOf = (tenantId: string, changeSetId: string): string =>
  `appr:cops:${createHash('sha256').update(JSON.stringify([tenantId, changeSetId])).digest('hex').slice(0, 32)}`;

/** Starts the execution run for an approved change set; set by the feature at boot. */
type ExecutionStarter = (input: { tenantId: string; orgId: string; approvalId: string; changeSetId: string; changeSetHash: string; approvedBy: string }) => Promise<string>;
let startExecution: ExecutionStarter | null = null;
export function registerChangeSetExecutionStarter(fn: ExecutionStarter): void { startExecution = fn; }

/** Best-effort audit-chain entry; never fails the action it records. */
export function auditOps(tenantId: string, kind: string, payload: Record<string, unknown>): void {
  void appendAudit(tenantId, `campaign-ops.${kind}`, payload).catch((err) =>
    log.warn('campaign_ops_audit_failed', { kind, error: err instanceof Error ? err.message : String(err) }));
}

/** ADR 0924 ctx op — a proposed change set enters review and opens its row. */
export async function requestChangeSetApproval(tenantId: string, orgId: string, changeSetId: string, by: string): Promise<{ changeSet: ChangeSet; approval: PendingApproval }> {
  const client = await getClient(tenantId, orgId);
  if (!client || client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
  const cs = await getChangeSet(tenantId, orgId, changeSetId);
  if (!cs) throw new OpenwopError('not_found', 'Change set not found.', 404, { changeSetId });
  const req = await getRequest(tenantId, orgId, cs.requestId);
  if (!req || req.version !== cs.requestVersion) {
    await transitionChangeSet(tenantId, orgId, changeSetId, ['proposed'], 'stale', { staleReason: 'request_changed' });
    throw new OpenwopError('conflict', 'The request was edited after this change was prepared.', 409, { reason: 'request_changed' });
  }
  const approvalId = changeSetApprovalIdOf(tenantId, changeSetId);
  if (cs.status === 'proposed') {
    if (!(await transitionChangeSet(tenantId, orgId, changeSetId, ['proposed'], 'in_review'))) {
      throw new OpenwopError('conflict', 'The change set changed; reload it.', 409, { reason: 'change_set_changed' });
    }
  } else if (cs.status !== 'in_review') {
    throw new OpenwopError('validation_error', `This change set cannot go to review (status: ${cs.status}).`, 409, { reason: 'not_reviewable', status: cs.status });
  }
  const labels = cs.entries.map((e) => e.label).join(', ');
  const { approval } = await createChangeSetApprovalOnce({
    tenantId, orgId, approvalId,
    changeSetId, changeSetHash: cs.hash,
    requestId: cs.requestId, requestVersion: cs.requestVersion,
    sourceVersions: Object.fromEntries(cs.entries.map((e) => [e.assetId, { version: e.sourceVersion, contentHash: e.sourceContentHash }])),
    proposedBy: by,
    proposal: `Approve the change for ${client.displayName}: ${req.text.slice(0, 200)} (${labels})`,
  });
  auditOps(tenantId, 'approval.requested', { orgId, changeSetId, changeSetHash: cs.hash, approvalId, by });
  return { changeSet: (await getChangeSet(tenantId, orgId, changeSetId)) ?? cs, approval };
}

async function closeStale(approvalId: string, tenantId: string, orgId: string, changeSetId: string, reason: 'request_changed' | 'asset_changed', note: string): Promise<void> {
  await resolveApproval(approvalId, { status: 'rejected', note });
  await transitionChangeSet(tenantId, orgId, changeSetId, ['in_review'], 'stale', { staleReason: reason });
}

async function decideChangeSet(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; expectedChangeSetHash?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'campaign-change-set') return null;
  const orgId = approval.orgId ?? '';
  const changeSetId = approval.changeSetId ?? '';
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  // 6 — the client org's own approvers (never the tenant at large).
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
  if (!access.scopes.includes('approvals:respond')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: approvals:respond', 403, { requiredScope: 'approvals:respond' });
  }
  const cs = await getChangeSet(tenantId, orgId, changeSetId);
  if (!cs) return null;

  if (outcome === 'approved') {
    // 1 — approve what you saw.
    if (!opts.expectedChangeSetHash || opts.expectedChangeSetHash !== approval.changeSetHash || cs.hash !== approval.changeSetHash) {
      throw new OpenwopError('conflict', 'This approval is for a different version of the change. Reload it and review what will be written.', 409, { reason: 'change_set_mismatch' });
    }
    // 2 — the request has not moved on.
    const req = await getRequest(tenantId, orgId, cs.requestId);
    if (!req || req.version !== approval.changeSetRequestVersion) {
      await closeStale(approvalId, tenantId, orgId, changeSetId, 'request_changed', 'The request was edited after this change was prepared, so this review was closed.');
      auditOps(tenantId, 'approval.refused', { orgId, changeSetId, reason: 'request_changed' });
      throw new OpenwopError('conflict', 'The request was edited after this change was prepared. Regenerate it to review again.', 409, { reason: 'request_changed' });
    }
    // 3 — no newer human edit to any affected asset.
    const moved: string[] = [];
    for (const [assetId, src] of Object.entries(approval.changeSetSourceVersions ?? {})) {
      const asset = await getAsset(tenantId, orgId, assetId);
      const snap = asset ? await adapterFor(asset.destination)?.read(asset, { tenantId }) : null;
      if (!snap || snap.version !== src.version || snap.contentHash !== src.contentHash) moved.push(assetId);
    }
    if (moved.length > 0) {
      const labels = cs.entries.filter((e) => moved.includes(e.assetId)).map((e) => e.label);
      await closeStale(approvalId, tenantId, orgId, changeSetId, 'asset_changed', `Someone edited ${labels.join(', ')} after this change was prepared, so this review was closed.`);
      auditOps(tenantId, 'approval.refused', { orgId, changeSetId, reason: 'asset_changed', assetIds: moved });
      throw new OpenwopError('conflict', `Someone edited ${labels.join(', ')} after this change was prepared. Regenerate it to review again.`, 409, { reason: 'asset_changed', assetIds: moved });
    }
    // 4 — the client is still active.
    const client = await getClient(tenantId, orgId);
    if (!client || client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
    // 5 — separation of duties (the CMS rule, ADR 0924 D2): the person who asked
    // may not approve while someone else on the client can. A sole approver is not
    // locked out. Unresolvable identities count as the proposer (fail closed).
    const recorded = approval.changeSetProposedBy ?? '';
    const proposer = recorded ? await canonicalDecider(tenantId, recorded) : null;
    const decider = await canonicalDecider(tenantId, decidedBy);
    if ((!proposer || !decider || proposer === decider)
      && await hasDistinctScopeHolder(tenantId, 'approvals:respond', proposer ?? recorded ?? decidedBy, { orgId })) {
      throw new OpenwopError('forbidden', 'You asked for this change, so someone else has to approve it.', 403, { reason: 'separation-of-duties' });
    }
  }

  const lock = await resolveApproval(approvalId, {
    status: outcome,
    decidedBy,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  if (outcome === 'rejected') {
    await transitionChangeSet(tenantId, orgId, changeSetId, ['in_review'], 'rejected');
    auditOps(tenantId, 'approval.rejected', { orgId, changeSetId, changeSetHash: cs.hash, approvalId, by: decidedBy });
    return { approval: lock.approval, changed: true };
  }
  try {
    if (!(await transitionChangeSet(tenantId, orgId, changeSetId, ['in_review'], 'approved'))) {
      throw new OpenwopError('conflict', 'The change set changed while it was being approved. Try again.', 409, { reason: 'change_set_changed' });
    }
    if (!startExecution) throw new OpenwopError('conflict', 'Campaign operations cannot start the change on this host.', 409, { reason: 'execution_unavailable' });
    const runId = await startExecution({ tenantId, orgId, approvalId, changeSetId, changeSetHash: cs.hash, approvedBy: decidedBy });
    auditOps(tenantId, 'approval.approved', { orgId, changeSetId, changeSetHash: cs.hash, approvalId, by: decidedBy, runId });
    return { approval: { ...lock.approval, runId }, changed: true };
  } catch (err) {
    await transitionChangeSet(tenantId, orgId, changeSetId, ['approved'], 'in_review');
    await reopenApproval(approvalId);
    throw err;
  }
}

export function registerChangeSetApproval(): void {
  registerCampaignChangeSetApprovalHandler(decideChangeSet);
}
