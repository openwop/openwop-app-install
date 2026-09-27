/**
 * Recommendations (ADR 0273 / MERCH-A) — a feature-package that COMPOSES the
 * commerce catalog + the priority-matrix scoring engine + CRM segments + the
 * shared bucketing primitive to produce full-funnel product recommendations
 * (upsell/cross-sell/FBT). Toggle OFF ⇒ zero behavior change. Depends on commerce
 * (no catalog ⇒ no recs — a genuine hard dep, disable-lock); recommends CRM (only
 * needed for segment targeting, which degrades gracefully). Host-extension — no RFC.
 *
 * @see docs/adr/0273-merch-a-recommendations-upsell-crosssell.md
 */
import type { BackendFeature } from '../types.js';
import { registerRecommendationsRoutes } from './routes.js';
import { buildRecommendationsSurface } from './surface.js';
import { registerRecommendationsAgentTools } from './agentTools.js';
import { startRecoAffinitySweep } from './affinityRebuild.js';

export const recommendationsFeature: BackendFeature = {
  id: 'recommendations',
  registerRoutes: (deps) => {
    registerRecommendationsRoutes(deps);
    // CFP-1 — the Merchandiser's conversational tools (chat-first port).
    registerRecommendationsAgentTools();
    startRecoAffinitySweep();
  },
  surface: { id: 'recommendations', build: buildRecommendationsSurface },
  toggleDefault: {
    id: 'recommendations',
    label: 'Recommendations',
    description: 'Product recommendations + upsell/cross-sell + frequently-bought-together (MERCH-A).',
    category: 'Commerce',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'recommendations',
  },
  requiredPacks: [
    { name: 'feature.recommendations.nodes', version: '1.0.0' },
    { name: 'feature.recommendations.agents', version: '1.0.1' },
  ],
  dependsOn: ['commerce'],
  // Frequently-bought-together reranking pulls the Priority Matrix weights (imports
  // `../priority-matrix`); CRM enriches the audience — both advisory.
  recommends: ['crm', 'priority-matrix'],
};
