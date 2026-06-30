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

export const campaignIntelFeature: BackendFeature = {
  id: 'campaign-intel',
  registerRoutes: (deps) => registerCampaignIntelRoutes(deps),
  surface: { id: 'campaign-intel', build: buildCampaignIntelSurface },
  requiredPacks: [
    { name: 'feature.campaign-intel.nodes', version: '1.0.0' },
    { name: 'feature.campaign-intel.agents', version: '1.0.0' },
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
};
