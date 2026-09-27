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
      label: 'Support', labelKey: 'serviceDeskLabel',
      icon: LifeBuoyIcon,
      hint: 'Ticket queue + threads', hintKey: 'serviceDeskHint',
      featureId: 'service-desk',
    },
  },
];

export const serviceDeskFeature: FrontendFeature = { id: 'service-desk', routes };
