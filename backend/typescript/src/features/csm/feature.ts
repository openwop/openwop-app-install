/**
 * CSM — the second feature, added as a PURE addition (ADR 0001 §6 Phase 6).
 * Wiring it required ONLY appending to BACKEND_FEATURES (backend) and
 * FRONTEND_FEATURES (frontend) — zero edits to core route/nav code, which is
 * the whole point of the feature-package contract.
 *
 * Tenant-bucketed, off by default. Originally a plain on/off feature with no
 * packs; extended 2026-06-10 (ADR 0016 Correction / `/feature` audit) with the
 * core-app extension surface — a `ctx.features.csm` workflow surface + node/agent
 * packs — all behind the SAME `csm` toggle.
 */

import type { BackendFeature } from '../types.js';
import { registerCsmRoutes } from './routes.js';
import { buildCsmSurface, CSM_SURFACE_POLICY } from './surface.js';
import { registerCsmAgentTools } from './agentTools.js';
import { onCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { scrubCrmRefsForDeletedCompany } from './accountsService.js';

export const csmFeature: BackendFeature = {
  id: 'csm',
  registerRoutes: (deps) => {
    registerCsmRoutes(deps);
    registerCsmAgentTools(); // CFP-1 — health-insights chat tool over ctx.features.csm (ADR 0308 D2)
    // ADR 0283 consumer (grade-data CRM-5) — scrub account.crmRef when its CRM
    // company is deleted (the account + health history keep standalone value).
    onCrmRecordDeleted('csm', async ({ tenantId, entity, recordId, orgId }) => {
      // CSM-13 — pass the org through so the scrub can narrow on BOTH halves of
      // the ref; it is optional on this payload and the scrub degrades to the
      // company-only match when it is absent.
      if (entity === 'company') await scrubCrmRefsForDeletedCompany(tenantId, recordId, orgId);
    });
  },
  // Face 2 (ADR 0014): `ctx.features.csm` — a thin, tenant-guarded read/health
  // adapter over accountsService that backs the feature.csm.nodes pack.
  // ADR 0882 D1 — the closed-world partition + run floors (CSM2WF-1/-2).
  surface: { id: 'csm', build: buildCsmSurface, orgPolicy: CSM_SURFACE_POLICY },
  toggleDefault: {
    id: 'csm',
    label: 'CSM',
    description: 'Customer-success accounts + health — sample product feature.',
    category: 'CRM',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'csm',
  },
  // Hard dep: accountsService imports the CRM store (`../crm`) — customer-success
  // accounts are CRM accounts, so CSM cannot function without the CRM core
  // (ADR 0194 disable-lock).
  dependsOn: ['crm'],
  requiredPacks: [
    // ADR 0582 §4/§5 — nodes 1.4.0 (the computed path refuses an absent/partial/
    // unscopeable fan-in), agents 1.1.0 (the prompt states unscored ≠ low, that a
    // recorded measurement failure supersedes the number beside it, and that a
    // factor breakdown is only interpretable with its `healthMethod`).
    // ADR 0882 — nodes 1.5.0 (health-set names its org; the three play nodes),
    // agents 1.3.0 (the renewals-due read tool).
    'feature.csm.nodes',
    'vendor.openwop-app.csm.agents',
  ],
};
