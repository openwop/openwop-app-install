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
import type { BackendFeature } from '../types.js';
import { registerFunnelsRoutes } from './routes.js';
import { registerFunnelsFormsSink } from './formsAttributionSink.js';
import { registerFunnelsAgentTools } from './agentTools.js';
import { buildFunnelsSurface } from './surface.js';
import { startFunnelStatsSweep } from './funnelStats.js';

export const funnelsFeature: BackendFeature = {
  id: 'funnels',
  registerRoutes: (deps) => {
    registerFunnelsRoutes(deps);
    registerFunnelsFormsSink(); // ADR 0332 §D3 — opt-in capture attribution (funnels → forms seam)
    // CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the Funnel Architect's real chat tools
    // (openwop:funnels.list/get/step-stats/draft), sharing the routes' authority.
    registerFunnelsAgentTools();
    // Phase 3 — the derived stats rebuild sweep (reservation/affinity clone).
    startFunnelStatsSweep();
  },
  surface: { id: 'funnels', build: buildFunnelsSurface },
  toggleDefault: {
    id: 'funnels',
    label: 'Funnels',
    description: 'Multi-step sales funnels composed from CMS pages (Funnel A / ADR 0294).',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'funnels',
  },
  requiredPacks: [
    { name: 'feature.funnels.nodes', version: '1.0.0' },
    { name: 'feature.funnels.agents', version: '1.0.1' },
  ],
  // Checkout/upsell steps ride commerce; step-event tracking is consent-gated
  // (imports `../consent`) — both advisory.
  recommends: ['commerce', 'consent', 'cdp', 'cms'],
};
