import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const UsageDashboardPage = lazy(() => import('./UsageDashboardPage.js').then((m) => ({ default: m.UsageDashboardPage })));

const routes: FeatureRoute[] = [
  {
    path: '/usage',
    element: <UsageDashboardPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Analytics & usage',
      label: 'LLM usage', labelKey: 'usageAnalyticsLabel',
      icon: ActivityIcon,
      hint: 'Per-model token usage', hintKey: 'usageAnalyticsHint',
      featureId: 'usage-analytics',
    },
  },
];

export const usageAnalyticsFeature: FrontendFeature = { id: 'usage-analytics', routes };
