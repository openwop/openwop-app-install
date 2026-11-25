/**
 * ADR 1099 D6 (P3) — a collaborator's proposals: held, never written, until a
 * member of the firm approves each one.
 *
 * In a collaborator turn a `propose` client tool returns proposals instead of
 * writing. Each becomes ONE `collab-proposal` approval (`createCollabProposalApproval`,
 * a deterministic id from the grant, the tool and the tool's idempotency key, so a
 * rerun adds nothing). The member sees each item in the approvals inbox of the
 * project's org (`workspace:write`), grouped by `groupKey`.
 *
 * On approve (`decideCollabProposal`): the decider must hold `workspace:write` in
 * the org, and pass the tool's own `mayDecide` when it has one (both for approve and
 * reject; refused is 403 `collab_not_decider`, nothing changes); the grant must still be active and unexpired, or approve is refused
 * (409 `collab_grant_ended`, the row stays pending so a member can reject it);
 * then CAS pending→approved, then the tool's `apply` with the scope rebuilt from
 * the grant. If `apply` throws, the approval is reopened, so it never reads as
 * approved when nothing landed: a 4xx `OpenwopError` from `apply` (the adopter's own
 * refusal) is passed through as is, anything else is a 500. On reject nothing is
 * written, and the row's summary and payload (the collaborator's words) are redacted.
 *
 * A collaborator's erasure redacts their proposals and cancels the pending ones
 * (the `collab-proposal` redactor, `onSubjectMatch: 'cancel'`).
 */
import { OpenwopError } from '../types.js';
import {
  createCollabProposalApproval, eraseApprovalSubject, getApproval, redactRejectedCollabProposal, registerCollabProposalApprovalHandler, reopenApproval, resolveApproval,
  type PendingApproval,
} from './approvalService.js';
import { resolveEffectiveAccess } from './accessControlService.js';
import { getGrant, registerCollaboratorEraseHook, type GrantUse } from './externalCollaborators.js';
import { checkProposals, clientProjectTool, type ClientProposeTool, type ClientToolScope } from './clientProjectTools.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.collabProposals');
const DECIDE_SCOPE = 'workspace:write';

export interface HeldProposals { held: number; duplicates: number; groupKeys: string[] }

/** Run a propose tool and hold what it returns. Writes nothing but the approvals. */
export async function holdProposals(use: GrantUse, tool: ClientProposeTool, scope: ClientToolScope, input: Record<string, unknown>, runId: string): Promise<HeldProposals> {
  const proposals = checkProposals(tool.id, await tool.run(scope, input));
  let held = 0;
  let duplicates = 0;
  for (const p of proposals) {
    const r = await createCollabProposalApproval({
      tenantId: use.tenantId,
      orgId: use.orgId,
      proposal: {
        grantId: use.grant.grantId,
        collaboratorId: use.collaborator.collaboratorId,
        resource: { kind: use.grant.resource.kind, id: use.grant.resource.id },
        toolId: tool.id,
        groupKey: p.groupKey,
        idempotencyKey: p.idempotencyKey,
        summary: p.summary,
        payload: p.payload,
        runId,
        ...(scope.audience ? { audience: scope.audience } : {}),
      },
    });
    if (r.created) held += 1; else duplicates += 1;
  }
  return { held, duplicates, groupKeys: [...new Set(proposals.map((p) => p.groupKey))] };
}

function scopeFromApproval(a: PendingApproval): ClientToolScope | null {
  const p = a.collabProposal;
  if (!p || !a.orgId) return null;
  return {
    tenantId: a.tenantId, orgId: a.orgId,
    resourceKind: p.resource.kind, resourceId: p.resource.id,
    grantId: p.grantId, collaboratorId: p.collaboratorId,
    ...(p.audience ? { audience: p.audience } : {}),
  };
}

export async function decideCollabProposal(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'collab-proposal' || !approval.collabProposal || !approval.orgId) return null;
  const p = approval.collabProposal;

  // Authority before the CAS, so an unauthorized decide never consumes the row.
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId: approval.orgId });
  if (!(access.scopes as readonly string[]).includes(DECIDE_SCOPE)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${DECIDE_SCOPE}`, 403, { requiredScope: DECIDE_SCOPE });
  }

  const scope = scopeFromApproval(approval);
  const tool = clientProjectTool(p.toolId);
  // The tool may name who decides (both verbs). A fault refuses, like a no.
  if (tool?.effect === 'propose' && tool.mayDecide && scope && approval.status === 'pending') {
    const decide = tool.mayDecide;
    const allowed = await decide(scope, { userId: decidedBy }).catch(() => false);
    if (!allowed) {
      const who = tool.deciderLabel ?? 'the person this project names';
      throw new OpenwopError('forbidden', `Only ${who} can decide this proposal.`, 403, { approvalId, reason: 'collab_not_decider', ...(tool.deciderLabel ? { decider: tool.deciderLabel } : {}) });
    }
  }
  if (outcome === 'approved' && approval.status === 'pending') {
    // The collaborator's access must still hold: a revoked or expired grant's
    // proposals are not applied (a member can still reject them).
    const grant = await getGrant(tenantId, approval.orgId, p.grantId);
    if (!grant || grant.status !== 'active' || !(Date.parse(grant.expiresAt) > Date.now())) {
      throw new OpenwopError('conflict', 'This person\'s access has ended, so their proposal cannot be applied. You can reject it.', 409, { approvalId, reason: 'collab_grant_ended' });
    }
    if (!tool || tool.effect !== 'propose' || !scope) {
      throw new OpenwopError('conflict', 'The tool that made this proposal is not available on this host.', 409, { approvalId, reason: 'collab_tool_unavailable' });
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
    // A declined item keeps no copy of the collaborator's words (best-effort; the
    // row is already rejected and nothing was written).
    await redactRejectedCollabProposal(tenantId, approvalId).catch((err: unknown) => {
      log.warn('collab_proposal_reject_redact_failed', { approvalId, error: err instanceof Error ? err.message : String(err) });
    });
    return { approval: lock.approval, changed: true };
  }

  try {
    await (tool as ClientProposeTool).apply(scope as ClientToolScope, p.payload, { approvalId, decidedBy });
  } catch (err) {
    log.warn('collab_proposal_apply_failed', { approvalId, tool: p.toolId, error: err instanceof Error ? err.message : String(err) });
    await reopenApproval(approvalId);
    // The adopter's own refusal (a 4xx it chose) reaches the member as it is.
    if (err instanceof OpenwopError && err.httpStatus >= 400 && err.httpStatus < 500) throw err;
    throw new OpenwopError('internal_error', 'The proposal could not be applied. It is still waiting for review.', 500, { approvalId });
  }
  return { approval: lock.approval, changed: true };
}

let registered = false;
/** Boot: the decision handler and the collaborator-erasure hook. Idempotent. */
export function registerCollabProposalGate(): void {
  registerCollabProposalApprovalHandler(decideCollabProposal);
  if (registered) return;
  registered = true;
  registerCollaboratorEraseHook(async (c) => eraseApprovalSubject(c.tenantId, c.collaboratorId));
}
