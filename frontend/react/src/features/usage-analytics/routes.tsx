import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const UsageDashboardPage = lazy(() => import('./UsageDashboardPage.js').then((m) => ({ default: m.UsageDashboardPage })));

const routes: FeatureRoute[] = [
  {
    path: '/usage',
    element: <UsageDashboardPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'LLM usage',
      icon: ActivityIcon,
      hint: 'Per-model token usage',
      featureId: 'usage-analytics',
    },
  },
];

export const usageAnalyticsFeature: FrontendFeature = { id: 'usage-analytics', routes };
