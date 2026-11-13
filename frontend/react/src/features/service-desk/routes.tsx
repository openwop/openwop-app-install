import { lazy } from 'react';
import { LifeBuoyIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SupportPage = lazy(() => import('./SupportPage.js').then((m) => ({ default: m.SupportPage })));

const routes: FeatureRoute[] = [
  {
    path: '/support',
    element: <SupportPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Business',
      labelKey: 'serviceDeskLabel',
      icon: LifeBuoyIcon,
      hintKey: 'serviceDeskHint',
      featureId: 'service-desk',
    },
  },
];

export const serviceDeskFeature: FrontendFeature = { id: 'service-desk', routes };
