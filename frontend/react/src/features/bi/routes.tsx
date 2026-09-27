import { lazy } from 'react';
import { BarChartIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MetricsPage = lazy(() => import('./MetricsPage.js').then((m) => ({ default: m.MetricsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/metrics',
    element: <MetricsPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Analytics & usage',
      label: 'Business metrics', labelKey: 'biLabel',
      icon: BarChartIcon,
      hint: 'Governed metric catalog', hintKey: 'biHint',
      featureId: 'bi',
    },
  },
];

export const biFeature: FrontendFeature = { id: 'bi', routes };
