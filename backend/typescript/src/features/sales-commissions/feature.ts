/**
 * Sales Commissions — the backend feature module (ADR 0280).
 *
 * Rep incentive compensation over CRM deals (ADR 0008) + territory quota
 * attainment (ADR 0272): plans pay a rep (the deal `owner`) for won deals at a
 * percentage/fixed rate, with accelerators past a quota-attainment threshold.
 * Host-extension only — no OpenWOP RFC (rides Accepted RFC 0049 scopes).
 *
 * Ships `off` (ADR 0001 §6 — brand-new feature). `bucketUnit: 'tenant'` — a
 * shared B2B surface (ADR 0015). The `ctx.features.commissions` surface + node/
 * agent packs land in P4, so no `surface`/`requiredPacks` yet.
 *
 * @see docs/adr/0280-sales-commissions.md
 */

import type { BackendFeature } from '../types.js';
import { registerCommissionRoutes } from './routes.js';
import { buildCommissionSurface } from './surface.js';
import { registerCommissionAgentTools } from './agentTools.js';
import { registerCommissionStatementGate } from './statementApproval.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseSubjectCommissions } from './entities/statement.js';
import { erasePlanSubject } from './entities/plan.js';

/** R2 COM2-M9 — subject erasure over FOUR subject-keyed fields no ratchet can see. */
async function eraseSalesCommissionsSubject(tenantId: string, subjectKey: string): Promise<void> {
  await eraseSubjectCommissions(tenantId, subjectKey);
  await erasePlanSubject(tenantId, subjectKey);
}

export const salesCommissionsFeature: BackendFeature = {
  id: 'sales-commissions',
  registerRoutes: (deps) => {
    registerCommissionRoutes(deps);
    // CFP-1 (D9) — the advisory Commissions Analyst's READ chat tools (self-gating
    // on the `sales-commissions` toggle per call; fail-empty without an acting
    // user; statement reads subject-scoped like the route).
    registerCommissionAgentTools();
    // CFP-1 (D9) — the statement-approval DECIDE handler on the shared approvals
    // hook. Approving a statement (payout-committing) is submitted for review; this
    // gate applies draft→approved behind host:commissions:manage (replacing the
    // demolished bespoke approve mutation). Safe regardless of toggle state.
    registerCommissionStatementGate();
    // R2 COM2-M9 — subject erasure over FOUR subject-keyed fields no ratchet can see.
    // Registered unconditionally: an erasure must not depend on a toggle being on today.
    // A MODULE-LEVEL NAMED reference, for the same two reasons spelled out in
    // `host/notificationSubjectErasure.ts`: `eraseSubject` names a failed eraser
    // via `fn.name` (R2 CN-SP-6, and an inline arrow's name is `''`), and
    // `registerSubjectEraser` dedupes BY REFERENCE (so an inline closure — arrow
    // OR named expression — re-registers as a duplicate). These two were the only
    // anonymous-arrow registrations in the tree.
    registerSubjectEraser(eraseSalesCommissionsSubject);
  },
  // Face 2 (ADR 0014) — the ctx.features.commissions workflow surface (P4).
  surface: { id: 'commissions', build: buildCommissionSurface },
  toggleDefault: {
    id: 'sales-commissions',
    label: 'Sales Commissions',
    description: 'Rep incentive compensation — commission plans (percentage/fixed + accelerators) over CRM won deals and territory quota attainment.',
    category: 'Sales',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'sales-commissions',
  },
  requiredPacks: [
    { name: 'feature.sales-commissions.nodes', version: '1.1.0' },
    { name: 'feature.sales-commissions.agents', version: '1.0.1' },
  ],
};
