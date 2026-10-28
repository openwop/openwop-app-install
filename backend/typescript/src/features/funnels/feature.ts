/**
 * Funnels (ADR 0294 / Funnel A) — multi-step conversion paths (opt-in → sales →
 * checkout → upsell → thank-you) composed from CMS pages (ADR 0009). A thin
 * composition layer: pages stay CMS-owned, public serving rides the publishing
 * gate (Phase 2), analytics ride the CDP event spine (Phase 3), experiments the
 * shared variant assigner (Phase 4). Host-extension — no RFC. CMS is always-on
 * (ADR 0027) so there is no cms toggle to depend on; commerce is recommended
 * (checkout/upsell steps degrade to content-only without it).
 *
 * @see docs/adr/0294-funnel-a-funnel-entity-builder-analytics.md
 */
import { registerFunnelBlueprints } from './blueprints.js';
import { registerFunnelPublishApprovalGate } from './funnelPublishApproval.js';
import type { BackendFeature } from '../types.js';
import { registerFunnelsRoutes } from './routes.js';
import { registerFunnelsFormsSink } from './formsAttributionSink.js';
import { registerFunnelsAgentTools } from './agentTools.js';
import { buildFunnelsSurface } from './surface.js';
import { startFunnelStatsSweep } from './funnelStats.js';
import { registerFunnelExperimentSurface } from './experimentSurface.js';
import { registerFeatureDataExporter } from '../../host/featureDataExport.js';
import { exportFunnelsData } from './dataExport.js';

export const funnelsFeature: BackendFeature = {
  id: 'funnels',
  registerRoutes: (deps) => {
    registerFeatureDataExporter('funnels', exportFunnelsData); // ADR 0820 §7 — read-only export, served after a plan lapse
    registerFunnelsRoutes(deps);
    registerFunnelsFormsSink(); // ADR 0332 §D3 — opt-in capture attribution (funnels → forms seam)
    // CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the Funnel Architect's real chat tools
    // (openwop:funnels.list/get/step-stats/draft), sharing the routes' authority.
    registerFunnelsAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
    // ADR 0948 P3a — every blueprint chain becomes a chain-backed workflow owned by
    // the funnels toggle (deterministic id, gated launch).
    registerFunnelBlueprints();
    // ADR 0948 P1b — the `funnel-publish` decide handler on the core approvals hook
    // (the inbox approve path dispatches here). Direction: feature → core only.
    registerFunnelPublishApprovalGate(deps.storage);
    // Phase 3 — the derived stats rebuild sweep (reservation/affinity clone).
    startFunnelStatsSweep();
    registerFunnelExperimentSurface(); // ADR 0949 P2a — the `funnel.step` experiment adapter
  },
  // ADR 0948 P1b — the writes a run may make need the same bar as their routes
  // (`workspace:write`); a read-only member's run can neither draft nor request a publish.
  surface: { id: 'funnels', build: buildFunnelsSurface, orgPolicy: { methodScopes: { create: 'workspace:write', setSteps: 'workspace:write', requestPublish: 'workspace:write' } } },
  toggleDefault: {
    id: 'funnels',
    label: 'Funnels',
    description: 'Multi-step sales funnels composed from CMS pages.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'funnels',
  },
  requiredPacks: [
    'feature.funnels.nodes',
    'vendor.openwop-app.funnels.agents',
  ],
  // Checkout/upsell steps ride commerce; step-event tracking is consent-gated
  // (imports `../consent`) — both advisory.
  recommends: ['commerce', 'consent', 'cdp', 'cms'],
};
