/**
 * ADR 0473 Phase 5 — super-admin administration of the composed-workflow
 * auto-approval policies (host-extension, non-normative). Mirrors the
 * agent-allowlists admin convention: platform-operator surface, superadmin
 * gate, every mutation audited.
 *
 *   GET    /v1/host/openwop-app/workflow-proposals/admin/policies?tenantId=…
 *   PUT    /v1/host/openwop-app/workflow-proposals/admin/policies/:tenantId/:agentProfileId
 *   DELETE /v1/host/openwop-app/workflow-proposals/admin/policies/:tenantId/:agentProfileId
 *
 * The policy's semantics (read-only-class nodes only, fail-closed on
 * undeclared roles, decisions attributed `policy:*` through the ONE decision
 * core) live in `host/workflowProposalPolicy.ts` + the propose tool's gate.
 */

import type { Express, Request } from 'express';
import type { Storage } from '../storage/storage.js';
import { requireSuperadmin } from '../host/superadmin.js';
import { OpenwopError } from '../types.js';
import {
  setProposalAutoApprovePolicy,
  clearProposalAutoApprovePolicy,
  listProposalAutoApprovePolicies,
} from '../host/workflowProposalPolicy.js';

const BASE = '/v1/host/openwop-app/workflow-proposals/admin/policies';

function subjectOf(req: Request): string {
  return req.userId ?? req.principal?.principalId ?? 'unknown';
}

export function registerWorkflowProposalPolicyRoutes(app: Express, deps: { storage: Storage }): void {
  app.get(BASE, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Workflow-proposal auto-approval administration');
      const tenantId = String(req.query.tenantId ?? '');
      if (!tenantId) throw new OpenwopError('validation_error', 'tenantId query parameter is required.', 400, {});
      res.status(200).json({ items: await listProposalAutoApprovePolicies(tenantId) });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/:tenantId/:agentProfileId`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Workflow-proposal auto-approval administration');
      const { tenantId, agentProfileId } = req.params;
      if (!tenantId || !agentProfileId) throw new OpenwopError('validation_error', 'tenantId and agentProfileId are required.', 400, {});
      const policy = await setProposalAutoApprovePolicy({ tenantId, agentProfileId, createdBy: subjectOf(req) });
      void deps.storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: subjectOf(req),
        action: 'workflows.proposal.autoapprove.enabled',
        resource: `agent:${agentProfileId}`,
        outcome: 'success',
        payload: { tenantId, agentProfileId },
      }).catch(() => {});
      res.status(200).json({ policy });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:tenantId/:agentProfileId`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Workflow-proposal auto-approval administration');
      const { tenantId, agentProfileId } = req.params;
      // Idempotent delete: absent is the desired end state — 200 either way.
      const removed = await clearProposalAutoApprovePolicy(tenantId ?? '', agentProfileId ?? '');
      void deps.storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: subjectOf(req),
        action: 'workflows.proposal.autoapprove.disabled',
        resource: `agent:${agentProfileId}`,
        outcome: 'success',
        payload: { tenantId, agentProfileId, removed },
      }).catch(() => {});
      res.status(200).json({ removed });
    } catch (err) { next(err); }
  });
}
