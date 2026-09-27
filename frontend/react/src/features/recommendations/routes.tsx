/**
 * Recommendations frontend feature (ADR 0273 / MERCH-A) — route + nav fragment.
 * Appended to FRONTEND_FEATURES; nav gated by `featureId: 'recommendations'`.
 */
import { lazy } from 'react';
import { SparklesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const RecommendationsPage = lazy(() => import('./RecommendationsPage.js').then((m) => ({ default: m.RecommendationsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/recommendations',
    element: <RecommendationsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Commerce', label: 'Recommendations', labelKey: 'recommendationsLabel', icon: SparklesIcon, hint: 'Upsell, cross-sell & recommendations', hintKey: 'recommendationsHint', order: 61, featureId: 'recommendations' },
  },
];

export const recommendationsFeature: FrontendFeature = { id: 'recommendations', routes };
