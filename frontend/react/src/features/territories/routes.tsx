/**
 * Sales Territory Management frontend feature (ADR 0272) — route + nav manifest.
 * Registered into FRONTEND_FEATURES; the nav entry carries `featureId:
 * 'territories'` so it hides unless the toggle resolves enabled for the caller.
 */
import { lazy } from 'react';
import { GlobeIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const TerritoriesPage = lazy(() => import('./TerritoriesPage.js').then((m) => ({ default: m.TerritoriesPage })));

const routes: FeatureRoute[] = [
  {
    path: '/territories',
    element: <TerritoriesPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Sales',
      label: 'Territories', labelKey: 'territoriesLabel',
      icon: GlobeIcon,
      hint: 'Sales regions, hierarchy, quotas & attainment', hintKey: 'territoriesHint',
      order: 47,
      featureId: 'territories',
    },
  },
];

export const territoriesFeature: FrontendFeature = { id: 'territories', routes };
