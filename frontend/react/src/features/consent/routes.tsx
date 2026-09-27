import { lazy } from 'react';
import { ShieldIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ConsentPage = lazy(() => import('./ConsentPage.js').then((m) => ({ default: m.ConsentPage })));

const routes: FeatureRoute[] = [
  {
    path: '/consent',
    element: <ConsentPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Customer Data Platform',
      label: 'Consent', labelKey: 'consentLabel',
      icon: ShieldIcon,
      hint: 'Region-aware consent + data-subject (GDPR)', hintKey: 'consentHint',
      featureId: 'consent',
    },
  },
];

export const consentFeature: FrontendFeature = { id: 'consent', routes };
