/**
 * Campaign Studio: Campaign Intelligence (ADR 0160). The analysis layer over the
 * performance store (ADR 0159) — budget recommendations + forecasting, driven
 * through the one chat by the Campaign Intelligence Analyst (ADR 0058). The last
 * layer of the Campaign Studio cluster. Composes performance + Notifications;
 * forks neither (no parallel analytics dashboard).
 *
 * RFC gate (ADR 0160): host work over the performance store. NO new RFC.
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import type { BackendFeature } from '../types.js';
import { registerCampaignIntelRoutes } from './routes.js';
import { buildCampaignIntelSurface } from './surface.js';
import { registerCampaignIntelAgentTools } from './agentTools.js';

export const campaignIntelFeature: BackendFeature = {
  id: 'campaign-intel',
  registerRoutes: (deps) => {
    registerCampaignIntelRoutes(deps);
    // CFP-1 (docs/chat-first-port/e4-campaign-connectors-intel.md, C14) — bridge
    // the intel surface into the ONE chat so the Campaign Intelligence Analyst has
    // REAL tools (budget-optimize / forecast / plan-budget) instead of a
    // silently-dropped node-typeId allowlist. The ADR 0308 D2 feature-registered-
    // builtin seam; per-tenant toggle honesty lives inside each tool's run.
    registerCampaignIntelAgentTools();
  },
  surface: { id: 'campaign-intel', build: buildCampaignIntelSurface },
  requiredPacks: [
    { name: 'feature.campaign-intel.nodes', version: '1.1.1' },
    { name: 'feature.campaign-intel.agents', version: '1.2.1' },
  ],
  toggleDefault: {
    id: 'campaign-intel',
    label: 'Campaign Intelligence',
    description:
      'Turn campaign performance into decisions — budget recommendations (shift spend toward higher ROAS), creative-fatigue detection, and outcome forecasts. Ask the Campaign Intelligence Analyst in chat ("how should I allocate my budget?") for data-backed answers. The last layer of Campaign Studio. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-intel',
  },
  // ADR 0200 Phase 1 — SOFT dep (advisory, never a lock): Intelligence analyzes
  // performance records that Campaign Connectors syncs (performanceService); it
  // reads the store directly (toggle-decoupled), so it degrades to "no data yet"
  // rather than orphaning. The console suggests enabling connectors.
  recommends: ['campaign-connectors'],
};
