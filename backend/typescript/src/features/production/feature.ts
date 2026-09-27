/**
 * Production Intelligence (ADR 0172) — the Vendor Directory + AI production
 * planning, completing the MyndHyve "Production Intelligence (CS-010)" port that
 * ADR 0005 began (Team Profiles only). Backend half: the vendor/plan routes, a
 * `production` toggle (off; tenant-bucketed — a shared B2B surface), the
 * `ctx.features.production` workflow surface (ADR 0014), the `production.plan`
 * artifact type (ADR 0055), and the `feature.production.{nodes,agents}` packs.
 *
 * Composes existing owners (Profiles / CRM / KB / Media / artifact-registry); the
 * ONLY net-new store is the Vendor entity. Host-extension — no wire, no RFC.
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import type { BackendFeature } from '../types.js';
import { registerProductionRoutes } from './routes.js';
import { buildProductionSurface } from './surface.js';
import { registerProductionArtifactType } from './artifactTypes.js';
import { registerProductionAgentTools } from './agentTools.js';

export const productionFeature: BackendFeature = {
  id: 'production',
  registerRoutes: (deps) => {
    registerProductionRoutes(deps);
    // Install the `production.plan` artifact type so a generated plan validates and
    // its schema is served at /schemas/artifacts/production.plan.schema.json.
    registerProductionArtifactType();
    // CFP-1 — the Production Planner's two chat tools (get-vendors read +
    // plan action). Registration is process-wide (per-tenant toggle honesty
    // lives in each tool's authority check); the run-starter deps ride the
    // closure since a chat-time tool scope carries no `storage`/`hostSuite`.
    registerProductionAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
  },
  // Face 2 (ADR 0014): `ctx.features.production` — buildContext + vendor/plan reads
  // + the plan-generate node's savePlan write.
  surface: { id: 'production', build: buildProductionSurface },
  toggleDefault: {
    id: 'production',
    label: 'Production Intelligence',
    description:
      'Vendor Directory (external contractors/agencies with capabilities, quality ratings, price ranges) + AI production planning — recommends a per-asset execution route (internal / contractor / agency / hybrid) with budget & timeline, ranking your team (Profiles) and vendors by channel fit. The Production Planner agent drives it from the AI chat or a workflow; plans render in the artifact workbench. OFF by default.',
    category: 'Studio',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'production',
  },
  requiredPacks: [
    { name: 'feature.production.nodes', version: '1.1.1' },
    { name: 'feature.production.agents', version: '1.0.1' },
  ],
};
