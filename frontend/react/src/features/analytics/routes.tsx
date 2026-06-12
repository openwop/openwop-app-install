import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AnalyticsPage = lazy(() => import('./AnalyticsPage.js').then((m) => ({ default: m.AnalyticsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/analytics',
    element: <AnalyticsPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Analytics',
      icon: ActivityIcon,
      hint: 'Traffic + conversions on the public surface',
      featureId: 'analytics',
    },
  },
];

export const analyticsFeature: FrontendFeature = { id: 'analytics', routes };
