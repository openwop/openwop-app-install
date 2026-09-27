/**
 * Production Intelligence frontend feature (ADR 0172) — route + nav manifest
 * fragment. Registered into FRONTEND_FEATURES; chrome/features.tsx composes it into
 * the app's FEATURES. The nav entry carries `featureId: 'production'` so it hides
 * unless the toggle resolves enabled for the caller.
 */
import { lazy } from 'react';
import { PackageIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ProductionPage = lazy(() => import('./ProductionPage.js').then((m) => ({ default: m.ProductionPage })));

const routes: FeatureRoute[] = [
  {
    path: '/production',
    element: <ProductionPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Studio',
      label: 'Production', labelKey: 'productionLabel',
      icon: PackageIcon,
      hint: 'Vendors + AI production planning', hintKey: 'productionHint',
      order: 46,
      featureId: 'production',
    },
  },
];

export const productionFeature: FrontendFeature = { id: 'production', routes };
