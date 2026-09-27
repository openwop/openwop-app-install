/**
 * Priority-Matrix scenario-select approval handler (CHAT-FIRST-PORT-AUDIT D3) —
 * the decide side of the agent-proposed scenario gate, the ADR 0230
 * `strategy/activationApproval.ts` pattern.
 *
 * An AGENT-proposed scenario (`proposedBy:'agent'`, ADR 0235 §D1) raises a
 * `kind: 'pm-scenario-select'` PendingApproval at `addScenario` time. A human
 * resolves it from the SAME reviews inbox every other proposal uses (approve ⇒
 * SELECT it as plan of record; reject ⇒ leave it un-adopted) OR from the scenario
 * page (whose "Select" control now delegates to THIS same resolution for an
 * agent-proposed scenario — one durable decision record). A HUMAN-created
 * scenario has no approval and stays a plain page action.
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerScenarioSelectApprovalHandler`); this feature registers at boot.
 * Authority: `workspace:write` in the list's org — the SAME bar the select route
 * enforced (`loadListScoped(req, 'workspace:write')`), applied HERE because the
 * generic approvals route is tenant-scoped and cannot apply it.
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../host/approvalDecision.ts — the single decision core
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerScenarioSelectApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { selectScenario } from './scenarios.js';

/**
 * Resolve a scenario-select approval: enforce `workspace:write` in the list's org
 * + IDOR, flip the approval (CAS), then on `approved` SELECT the scenario as plan
 * of record (reject leaves it un-adopted — selection executes nothing, architect
 * Q1). Returns null when the approval is missing/cross-tenant, not a scenario
 * gate, or the scenario vanished (the route maps that to 404). Throws
 * `forbidden_scope` (403) when the decider lacks `workspace:write`.
 */
async function decideScenarioSelect(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'pm-scenario-select' || !approval.scenarioSelect) return null;

  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }
  const orgId = approval.orgId ?? '';
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
  if (!access.scopes.includes('workspace:write')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }

  const { listId, sessionId, scenarioId } = approval.scenarioSelect;

  // CAS flip pending→resolved; `changed` gates the effect so a losing concurrent
  // decide can't double-select. Resolve BEFORE selecting, then COMPENSATE
  // (re-open) if the select can't be applied — the ADR 0066 HIGH-1 lesson.
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  if (outcome === 'approved') {
    try {
      await selectScenario({ tenantId, orgId, listId, sessionId, scenarioId, actor: decidedBy });
    } catch (err) {
      await reopenApproval(approvalId);
      throw err;
    }
  }
  // reject: decline to adopt — the scenario is inert data, so no effect is applied.
  return { approval: lock.approval, changed: true };
}

/** Register the scenario-select decision handler on the core approvals hook
 *  (called from the priority-matrix feature at boot). */
export function registerScenarioSelectGate(): void {
  registerScenarioSelectApprovalHandler(decideScenarioSelect);
}
