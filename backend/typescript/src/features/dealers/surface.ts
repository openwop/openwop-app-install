/**
 * `ctx.features.dealers` workflow surface (ADR 0281 P3 / ADR 0014).
 *
 * READS (dealers/outlets/registrations) are open to any run scoped to the tenant.
 * The governed WRITE (approveRegistration) enforces `host:dealers:manage` against
 * the RUN OWNER (ADR 0272 A5 pattern); a system run with no acting user is DENIED.
 * The write node is kept OUT of the advisory Channel Manager agent's allowlist, so
 * it rides a governed chain behind an approval gate (ADR 0208 §2).
 *
 * `tenantId` comes from the run scope (never node args — CTI-1); `orgId` is
 * node-supplied and IDOR-guarded per accessor.
 *
 * @see docs/adr/0281-dealer-network-prm.md
 *
 * ADR 1034 D1 — CORRECTED. This block used to say the write methods were the
 * "governed-WORKFLOW lane, where the HITL gate lives in the CHAIN (author a
 * core.approvalGate before the transition node)". Nothing enforced that convention,
 * so `approveRegistration` decided a registration with no second person and recorded
 * `run:<runId>` as the decider. It now SUBMITS: it returns the registration's review
 * card, and only a human with `host:dealers:manage` decides it in `/reviews` — the
 * commissions precedent (R2 COM2-M3, `sales-commissions/surface.ts`).
 */

import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { listDealers, listOutlets } from './entities/dealer.js';
import { listRegistrations, getRegistration, registrationProposalText } from './entities/registration.js';
import { createDealerRegistrationApproval } from '../../host/approvalService.js';

export function buildDealerSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const viewer = scope.actingUserId;

  const requireManage = async (orgId: string): Promise<void> => {
    if (!viewer) throw new OpenwopError('forbidden_scope', 'A registration approval requires an acting user with host:dealers:manage (system runs denied).', 403, { requiredScope: 'host:dealers:manage' });
    const access = await resolveEffectiveAccess(tenantId, { subject: viewer, orgId });
    if (!access.scopes.includes('host:dealers:manage')) throw new OpenwopError('forbidden_scope', 'Missing required scope: host:dealers:manage', 403, { requiredScope: 'host:dealers:manage' });
  };

  return {
    // ── Reads ──
    listDealers: async (args) => ({ dealers: await listDealers(tenantId, str(args.orgId), { ...(optStr(args.territoryId) ? { territoryId: str(args.territoryId) } : {}), ...(optStr(args.status) ? { status: str(args.status) } : {}) }) }),
    listOutlets: async (args) => ({ outlets: await listOutlets(tenantId, str(args.orgId), { ...(optStr(args.dealerId) ? { dealerId: str(args.dealerId) } : {}) }) }),
    listRegistrations: async (args) => ({ registrations: await listRegistrations(tenantId, str(args.orgId), { ...(optStr(args.dealerId) ? { dealerId: str(args.dealerId) } : {}), ...(optStr(args.status) ? { status: str(args.status) } : {}) }) }),

    // ── Governed write (A5) — submits for review; never decides (ADR 1034 D1) ──
    approveRegistration: async (args) => {
      const orgId = str(args.orgId);
      await requireManage(orgId);
      const regId = str(args.regId);
      const reg = await getRegistration(tenantId, orgId, regId);
      if (reg.status !== 'pending') {
        throw new OpenwopError('conflict', `Only a pending registration can be submitted for approval (this one is ${reg.status}).`, 409, { regId, status: reg.status });
      }
      // Find-or-create WITHOUT reopening (architect H2). The card id is deterministic in
      // `regId`, so this returns an existing card whatever its status. A RESOLVED card on a
      // still-pending registration means a manager's decide has claimed it and is applying
      // it right now; reopening it here (what `queueRegistrationApproval` does for the admin
      // repair) would race that decide and leave a pending card on a decided registration.
      const review = await createDealerRegistrationApproval({
        tenantId, orgId, regId, dealerId: reg.dealerId,
        proposal: registrationProposalText(reg),
      });
      return { success: true, submittedForReview: true, review: { approvalId: review.approvalId, status: review.status } };
    },
  };
}
