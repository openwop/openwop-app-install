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
 * CFP Phase-4 review: the write methods below are the ADR 0208 governed-WORKFLOW
 * lane — the HITL gate lives in the CHAIN (author a core.approvalGate before the
 * transition node); they do NOT mint the shared page/inbox approval row. The HTTP
 * routes are the gated interactive lane.
 */

import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { listDealers, listOutlets } from './entities/dealer.js';
import { listRegistrations, decideRegistration } from './entities/registration.js';

export function buildDealerSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const viewer = scope.actingUserId;
  const actor = `run:${scope.runId ?? 'unknown'}`;

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

    // ── Governed write (A5) ──
    approveRegistration: async (args) => {
      const orgId = str(args.orgId);
      await requireManage(orgId);
      const registration = await decideRegistration(tenantId, orgId, str(args.regId), 'approved', actor);
      return { success: true, registration };
    },
  };
}
