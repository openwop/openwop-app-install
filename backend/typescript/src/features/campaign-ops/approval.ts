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
 *
 * ADR 0924 P2a: every vote, from a member or from the client portal, enters
 * through the host's `castApprovalVote`. The checks above are this kind's
 * per-vote hook (run on every vote, review C2); the CAS and run start are its
 * finalize; earlier votes are re-checked when a quorum completes (H3); and the
 * per-row SLA expiry rejects through the kind (H4).
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { hasDistinctScopeHolder, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { selfApprovalBlockedCore } from '../../host/approvalSelfCheck.js';
import { registerApprovalVoteHooks, type ApprovalDecisionCtx, type VoteLane } from '../../host/approvalDecision.js';
import { clearDecisions, type ReviewDecision } from '../../host/reviewDecisionLedger.js';
import {
  createChangeSetApprovalOnce,
  getApproval,
  registerCampaignChangeSetApprovalHandler,
  reopenApproval,
  resolveApproval,
  type PendingApproval,
} from '../../host/approvalService.js';
import { appendAudit } from '../../host/auditChainService.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
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

/** The recorded decider of a client-approver decision. No email: the approval row
 *  names the approver record, which the agency can read and erase. */
export const clientApproverSubject = (approverId: string): string => `client-approver:${approverId}`;
const CLIENT_APPROVER_PREFIX = 'client-approver:';

/**
 * ADR 0924 D2.5 / P2a (review M1, closes Q3) — separation of duties through the
 * shared helper (`host/approvalSelfCheck.ts`, ADR 0905 D3) instead of two
 * hand-copied comparisons. The requesters are the person who sent the change for
 * review AND the person who wrote the request: an MCP-made request's issuer is a
 * requester too, because `canonicalDecider` resolves a delegated key to its issuer.
 * A sole approver is not locked out (the helper's rule).
 */
async function selfApprovalBlocked(tenantId: string, approval: PendingApproval, decider: string): Promise<boolean> {
  const orgId = approval.orgId ?? '';
  const req = approval.changeSetRequestId ? await getRequest(tenantId, orgId, approval.changeSetRequestId) : null;
  const submitters = [approval.changeSetProposedBy, req?.createdBy].filter((s): s is string => typeof s === 'string' && s !== '');
  return selfApprovalBlockedCore({
    tenantId,
    approvalId: approval.approvalId,
    decidedBy: decider,
    submitters,
    otherApproverExists: (d, exclude) => hasDistinctScopeHolder(tenantId, 'approvals:respond', d, { orgId, alsoExclude: exclude }),
    logTag: 'campaign_change_set',
  });
}

/**
 * ADR 0924 D5 (security review 2026-10-19) — the agency member a client decision
 * rests on. The member who sends the link holds it, so a client approval must
 * never be weaker than an agency one: the sender must be able to approve for the
 * agency (`approvals:respond` on the client org, and not a requester while
 * someone else could approve) and to write (`workspace:write`). Checked when the
 * link is sent AND again when the client decides. `null` = fine.
 */
export async function agencyStandInRefusal(
  tenantId: string, orgId: string, subject: string, approval: PendingApproval,
): Promise<'not_an_approver' | 'cannot_write' | 'separation-of-duties' | null> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  if (!access.scopes.includes('approvals:respond')) return 'not_an_approver';
  if (!access.scopes.includes('workspace:write')) return 'cannot_write';
  if (await selfApprovalBlocked(tenantId, approval, subject)) return 'separation-of-duties';
  return null;
}

/** Who a client-approved change is written under, fixed at decision time so a
 *  re-sent link, a revoked approver or a fork of the execute run cannot move it. */
interface ClientDecision { tenantId: string; orgId: string; approvalId: string; approverId: string; writesAs: string; at: string }
const clientDecisions = new DurableCollection<ClientDecision>(
  'campaign-ops:client-decision',
  (d) => `${d.tenantId}::${d.approvalId}`,
  undefined,
  (d) => d.tenantId,
);

/** The member an approved change is written under: the agency approver, or for a
 *  client approval the member who sent the link (recorded at the decision). */
export async function writerOf(approval: PendingApproval): Promise<string | null> {
  const by = approval.decidedBy ?? '';
  if (!by.startsWith(CLIENT_APPROVER_PREFIX)) return by || null;
  const d = await clientDecisions.get(`${approval.tenantId}::${approval.approvalId}`);
  return d && d.tenantId === approval.tenantId && d.approvalId === approval.approvalId ? d.writesAs : null;
}

/** ADR 0464 — re-attribute an erased member recorded as a client decision's writer. */
export async function eraseClientDecisionWriters(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const d of await clientDecisions.listForTenantIndexed(tenantId)) {
    if (d.tenantId === tenantId && forms.has(d.writesAs) && await clientDecisions.compareAndSwap(d, { ...d, writesAs: tombstone })) n++;
  }
  return n;
}

/**
 * ADR 0924 D2 / P2a (review C2) — the per-vote checks, run by the host vote
 * entry (`castApprovalVote`) on EVERY vote before it is recorded or counted, so
 * on a quorum row a stale package or a self-approval is refused on the first
 * vote, not only on the one that completes it. Nothing here resolves the row
 * except the stale closures (2, 3), which close the review for every voter.
 *
 * Member lane (`agency`): a signed-in member (6: `approvals:respond` on the
 * CLIENT org); an approve needs their own session (review H5: an API key or a
 * delegated MCP key cannot cast the agency vote, the ADR 0942 D10.3 floor),
 * and under the `client` policy only the client approves (D4).
 * Client lane: the link's sender must still be able to stand in for the agency.
 * Approve, both lanes: 1 the hash, 2 the request, 3 the assets, 4 the client;
 * 5 separation of duties on the member lane.
 */
async function checkChangeSetVote(approval: PendingApproval, ctx: ApprovalDecisionCtx, outcome: 'approved' | 'rejected', lane: VoteLane): Promise<void> {
  const tenantId = approval.tenantId;
  const orgId = approval.orgId ?? '';
  const changeSetId = approval.changeSetId ?? '';
  let decidedBy: string;
  if (lane.party === 'agency') {
    if (!ctx.decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
    decidedBy = ctx.decidedBy;
    // Review H5 — the agency's approve is a person in their own session, never
    // an API key or a delegated (MCP) key: ADR 0942 D10.3 "no external effect
    // unattended from MCP", and the sole-admin rule's `not_a_person`. A reject
    // stays open to any eligible caller.
    if (outcome === 'approved' && ctx.decidedByHumanSession !== true) {
      throw new OpenwopError('forbidden', 'Approving a client change needs a person signed in to their own account, not an API key.', 403, { reason: 'not_a_person' });
    }
    // 6 — the client org's own approvers (never the tenant at large).
    const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
    if (!access.scopes.includes('approvals:respond')) {
      throw new OpenwopError('forbidden_scope', 'Missing required scope: approvals:respond', 403, { requiredScope: 'approvals:respond' });
    }
    // D4 `client` policy: only the client approves. An agency member may still reject.
    if (outcome === 'approved' && (await getClient(tenantId, orgId))?.approvalPolicy === 'client') {
      throw new OpenwopError('forbidden', 'This client approves its own changes. Send them the approval link.', 403, { reason: 'client_approval_required' });
    }
  } else {
    decidedBy = clientApproverSubject(lane.approverId);
    // The sender must still be able to stand in for the agency (see
    // `agencyStandInRefusal`). If not, the link is dead; the agency sends a new one.
    const refusal = await agencyStandInRefusal(tenantId, orgId, lane.sentBy, approval);
    if (refusal) {
      throw new OpenwopError('conflict', 'The person who sent this link can no longer approve it. The agency will send a new link.', 409, { reason: 'sender_unavailable', detail: refusal });
    }
  }
  const cs = await getChangeSet(tenantId, orgId, changeSetId);
  if (!cs) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
  if (outcome !== 'approved') return;

  // 1 — approve what you saw.
  if (!ctx.expectedChangeSetHash || ctx.expectedChangeSetHash !== approval.changeSetHash || cs.hash !== approval.changeSetHash) {
    throw new OpenwopError('conflict', 'This approval is for a different version of the change. Reload it and review what will be written.', 409, { reason: 'change_set_mismatch' });
  }
  // 2 — the request has not moved on.
  const req = await getRequest(tenantId, orgId, cs.requestId);
  if (!req || req.version !== approval.changeSetRequestVersion) {
    await closeStale(approval.approvalId, tenantId, orgId, changeSetId, 'request_changed', 'The request was edited after this change was prepared, so this review was closed.');
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
    await closeStale(approval.approvalId, tenantId, orgId, changeSetId, 'asset_changed', `Someone edited ${labels.join(', ')} after this change was prepared, so this review was closed.`);
    auditOps(tenantId, 'approval.refused', { orgId, changeSetId, reason: 'asset_changed', assetIds: moved });
    throw new OpenwopError('conflict', `Someone edited ${labels.join(', ')} after this change was prepared. Regenerate it to review again.`, 409, { reason: 'asset_changed', assetIds: moved });
  }
  // 4 — the client is still active.
  const client = await getClient(tenantId, orgId);
  if (!client || client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
  // 5 — separation of duties (the CMS rule, ADR 0924 D2): a requester may not
  // approve while someone else on the client can. A client approver is never a
  // requester (they have no session), so this is the member lane only; the
  // client lane's stand-in check above holds the sender to the same rule.
  if (lane.party === 'agency' && await selfApprovalBlocked(tenantId, approval, decidedBy)) {
    throw new OpenwopError('forbidden', 'You asked for this change, so someone else has to approve it.', 403, { reason: 'separation-of-duties' });
  }
}

/**
 * ADR 0924 P2a (review H3) — at completion, re-check every earlier counted vote
 * live. An agency vote still needs `approvals:respond` on the client org and must
 * not be a requester's; a client vote still needs an active link-only approver
 * whose current link grant is live. The vote's party is read from the vote, never
 * from the spelling of its ref. Only per-party rows reach this (single-decision
 * rows record no votes).
 */
async function staleChangeSetVotes(approval: PendingApproval, votes: ReviewDecision[]): Promise<Array<{ vote: ReviewDecision; reason: string }>> {
  const tenantId = approval.tenantId;
  const orgId = approval.orgId ?? '';
  const out: Array<{ vote: ReviewDecision; reason: string }> = [];
  for (const vote of votes) {
    if (vote.party === 'client') {
      const ref = vote.reviewerRef;
      const approverId = ref.startsWith(CLIENT_APPROVER_PREFIX) ? ref.slice(CLIENT_APPROVER_PREFIX.length) : '';
      const { clientVoteStillLive } = await import('./portal.js');
      if (!approverId || !(await clientVoteStillLive(tenantId, orgId, approval.changeSetId ?? '', approverId))) out.push({ vote, reason: 'client_approver_unavailable' });
      continue;
    }
    const access = await resolveEffectiveAccess(tenantId, { subject: vote.reviewerRef, orgId }).catch(() => null);
    if (!access || !access.scopes.includes('approvals:respond')) { out.push({ vote, reason: 'not_an_approver' }); continue; }
    if (await selfApprovalBlocked(tenantId, approval, vote.reviewerRef)) out.push({ vote, reason: 'separation-of-duties' });
  }
  return out;
}

/**
 * The kind's finalize (the registered handler), reached only through
 * `castApprovalVote` after `checkChangeSetVote` passed for the finalizing vote.
 * It makes the pending→resolved CAS and the change-set transition, and starts the
 * execution run. A client finalize records who the change is written under (the
 * link's sender); a member finalize writes as the member.
 */
async function finalizeChangeSet(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; expectedChangeSetHash?: string; clientVoter?: { approverId: string; sentBy: string } },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'campaign-change-set') return null;
  const orgId = approval.orgId ?? '';
  const changeSetId = approval.changeSetId ?? '';
  const decidedBy = opts.clientVoter ? clientApproverSubject(opts.clientVoter.approverId) : opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  // The agency member the approved change is written under (ADR 0924 as-built 4).
  const writesAs = opts.clientVoter ? opts.clientVoter.sentBy : decidedBy;
  const cs = await getChangeSet(tenantId, orgId, changeSetId);
  if (!cs) return null;
  if (outcome === 'approved' && cs.hash !== approval.changeSetHash) {
    throw new OpenwopError('conflict', 'This approval is for a different version of the change. Reload it and review what will be written.', 409, { reason: 'change_set_mismatch' });
  }

  if (opts.clientVoter && outcome === 'approved') {
    await clientDecisions.put({ tenantId, orgId, approvalId, approverId: opts.clientVoter.approverId, writesAs, at: new Date().toISOString() });
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
    const runId = await startExecution({ tenantId, orgId, approvalId, changeSetId, changeSetHash: cs.hash, approvedBy: writesAs });
    auditOps(tenantId, 'approval.approved', { orgId, changeSetId, changeSetHash: cs.hash, approvalId, by: decidedBy, ...(opts.clientVoter ? { writesAs } : {}), runId });
    return { approval: { ...lock.approval, runId }, changed: true };
  } catch (err) {
    await transitionChangeSet(tenantId, orgId, changeSetId, ['approved'], 'in_review');
    await reopenApproval(approvalId);
    throw err;
  }
}

/**
 * ADR 0924 P2a (review H4) — the per-row SLA expiry, through the kind. It used to
 * be a raw `resolveApproval(rejected)`, which left the change set `in_review`, its
 * links alive (answering the package and 404ing the decision) and its votes in
 * the ledger. Now the row is rejected by `system:sla-expiry` with the note
 * `sla_expired`, the change set moves to `rejected`, every link of it is dropped,
 * the ledger is cleared and the expiry is audited. No change-set row carries an
 * SLA until 0924 P2b attaches the 14-day expiry (user decision 2026-11-19, Q1).
 */
async function expireChangeSetReview(approval: PendingApproval): Promise<boolean> {
  if (approval.kind !== 'campaign-change-set') return false;
  const tenantId = approval.tenantId;
  const orgId = approval.orgId ?? '';
  const changeSetId = approval.changeSetId ?? '';
  const lock = await resolveApproval(approval.approvalId, { status: 'rejected', note: 'sla_expired', decidedBy: SLA_EXPIRY_ACTOR });
  if (!lock?.changed) return false;
  await transitionChangeSet(tenantId, orgId, changeSetId, ['in_review'], 'rejected');
  try {
    const { revokeLinksForChangeSet } = await import('./portal.js');
    await revokeLinksForChangeSet(tenantId, orgId, changeSetId);
  } catch (err) {
    log.warn('campaign_ops_expiry_link_cleanup_failed', { changeSetId, error: err instanceof Error ? err.message : String(err) });
  }
  await clearDecisions(approval.approvalId);
  auditOps(tenantId, 'approval.expired', { orgId, changeSetId, changeSetHash: approval.changeSetHash, approvalId: approval.approvalId, reason: 'sla_expired', by: SLA_EXPIRY_ACTOR });
  return true;
}
const SLA_EXPIRY_ACTOR = 'system:sla-expiry';

export function registerChangeSetApproval(): void {
  registerCampaignChangeSetApprovalHandler(finalizeChangeSet);
  registerApprovalVoteHooks('campaign-change-set', {
    voteCheck: checkChangeSetVote,
    staleVotes: staleChangeSetVotes,
    expire: expireChangeSetReview,
    acceptsClientVotes: true,
  });
}
