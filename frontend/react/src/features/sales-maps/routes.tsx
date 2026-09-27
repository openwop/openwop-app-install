/**
 * Dynamic Sales Maps frontend feature (ADR 0282) — route + nav manifest.
 * Registered into FRONTEND_FEATURES; `featureId: 'sales-maps'` gates the nav.
 * The MapView is a lazy chunk (only this manifest is entry-resident, ADR §10).
 */
import { lazy } from 'react';
import { GlobeIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SalesMapsPage = lazy(() => import('./SalesMapsPage.js').then((m) => ({ default: m.SalesMapsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/sales-map',
    element: <SalesMapsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Sales',
      label: 'Sales Map', labelKey: 'salesMapLabel',
      icon: GlobeIcon,
      hint: 'Territory attainment & dealer locations on a map', hintKey: 'salesMapHint',
      order: 50,
      featureId: 'sales-maps',
    },
  },
];

export const salesMapsFeature: FrontendFeature = { id: 'sales-maps', routes };
