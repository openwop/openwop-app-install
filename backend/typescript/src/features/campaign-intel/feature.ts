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
import { registerCampaignIntelErasure } from './erasure.js';
import { checkLaunchAgainstCaps } from './spendCaps.js';
import { setAdsCapChecker } from '../../host/adsAdapter.js';
import { MULTI_TOUCH_TOGGLE } from './attributionSettings.js';

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
    // ADR 0952 D2 — spend caps: the launch check rides the ONE ads adapter
    // (a breached, stale or unenforceable cap refuses `setDeliveryStatus` active),
    // and a cap's creator is tombstoned on erasure.
    setAdsCapChecker((tenantId, target) => checkLaunchAgainstCaps(tenantId, target));
    registerCampaignIntelErasure();
  },
  surface: { id: 'campaign-intel', build: buildCampaignIntelSurface },
  requiredPacks: [
    'feature.campaign-intel.nodes',
    'vendor.openwop-app.campaign-intel.agents',
  ],
  // ADR 0956 D2 — the multi-touch model report is a sub-capability, OFF until a
  // workspace opts in. Last-click stays the floor either way.
  extraToggleDefaults: [{
    id: MULTI_TOUCH_TOGGLE,
    label: 'Multi-touch attribution',
    description: 'Adds first-touch, linear, time-decay and position-based attribution beside last-click, over each conversion\'s touch path (deterministic identity links only). One model is shown at a time with all models compared; modelled credit is never added to platform-reported conversions. A sub-capability of Campaign Intelligence.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-intel-multi-touch',
  }],
  toggleDefault: {
    id: 'campaign-intel',
    label: 'Campaign Intelligence',
    description:
      'Turn campaign performance into decisions — budget recommendations (shift spend toward higher ROAS), creative-fatigue detection, and outcome forecasts. Ask the Campaign Intelligence Analyst in chat ("how should I allocate my budget?") for data-backed answers. The last layer of Campaign Studio.',
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
