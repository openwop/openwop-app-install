import { lazy } from 'react';
import { UsersIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CdpConsolePage = lazy(() => import('./CdpConsolePage.js').then((m) => ({ default: m.CdpConsolePage })));

const routes: FeatureRoute[] = [
  {
    path: '/cdp',
    element: <CdpConsolePage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Customer Data Platform',
      label: 'CDP', labelKey: 'cdpLabel',
      icon: UsersIcon,
      hint: 'Resolve a customer by any identifier', hintKey: 'cdpHint',
      featureId: 'cdp',
    },
  },
];

export const cdpFeature: FrontendFeature = { id: 'cdp', routes };
