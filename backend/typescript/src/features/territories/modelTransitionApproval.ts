/**
 * Territory model activation/archival approval handler (CFP-1 / D9) — the DECIDE
 * side of the model-transition gate, the `environments/promotionApproval.ts` pattern.
 *
 * Activating a territory model changes CRM record VISIBILITY + forecasting for the
 * whole org (an org-wide blast radius). Before this, it was a bespoke
 * `<button onClick={POST …/activate}>` on `TerritoriesPage` — a naked mutation
 * paralleling the shared HITL/reviews machinery (the D9 port map's BLOCKER 3 /
 * row 13). Now a manager SUBMITS a transition, which queues a
 * `kind: 'territory-model-transition'` PendingApproval on the shared reviews inbox;
 * a second manager claims/rejects it there, and THIS handler applies the transition
 * behind the org's `host:territories:manage` bar.
 *
 * Direction: feature → core only. Authority: `host:territories:manage` at the
 * approval's ORG scope — the SAME bar the old route enforced, reused here.
 *
 * @see ../../host/approvalService.ts / approvalDecision.ts — queue + decision core
 * @see ../../../docs/chat-first-port/d9-field-sales.md — the port map (row 13)
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerTerritoryTransitionApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { createLogger } from '../../observability/logger.js';
import { activateModel, archiveModel } from './entities/territories.js';
import { materializeAssignments } from './entities/assignment.js';
import { territoryMutated } from './emit.js';

const log = createLogger('territories.modelTransitionApproval');

async function decideTerritoryTransition(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'territory-model-transition' || !approval.territoryTransition || !approval.orgId) {
    return null;
  }
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide a territory transition.', 403, {});
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId: approval.orgId });
  if (!(access.scopes as readonly string[]).includes('host:territories:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:territories:manage', 403, { requiredScope: 'host:territories:manage' });
  }

  // Resolve-before-apply (CAS-gated side effect + compensation, ADR 0066 HIGH-1).
  const lock = await resolveApproval(approvalId, { status: outcome, ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}), ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  // A reject leaves the model in its current state — nothing to apply.
  if (outcome === 'rejected') return { approval: lock.approval, changed: true };

  const { modelId, transition } = approval.territoryTransition;
  const orgId = approval.orgId;
  try {
    if (transition === 'activate') {
      const model = await activateModel(tenantId, orgId, modelId, decidedBy);
      territoryMutated({ entity: 'model', verb: 'activated', tenantId, orgId, actor: decidedBy, entityId: model.modelId });
      // Materialize the newly-active model's assignments (best-effort — the
      // pointer CAS already committed, so a hiccup only means stale assignments
      // until POST /reassign; LOG it, never swallow). Mirrors the old route.
      await materializeAssignments(tenantId, orgId, model.modelId).catch((err: unknown) => {
        log.error('territory materialize-on-activate failed; run POST /reassign to recover', { err: String(err), modelId: model.modelId, orgId });
        return null;
      });
    } else {
      const archived = await archiveModel(tenantId, orgId, modelId, decidedBy);
      territoryMutated({ entity: 'model', verb: 'archived', tenantId, orgId, actor: decidedBy, entityId: archived.modelId });
    }
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  return { approval: lock.approval, changed: true };
}

/** Register the territory-model-transition decision handler on the core approvals
 *  hook (called from the territories feature at boot). */
export function registerTerritoryTransitionGate(): void {
  registerTerritoryTransitionApprovalHandler(decideTerritoryTransition);
}
