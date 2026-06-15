/**
 * Marketplace frontend feature — route + nav fragment (ADR 0022). Appended to
 * FRONTEND_FEATURES; nav gated by `featureId: 'marketplace'`.
 */
import { lazy } from 'react';
import { BoxesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MarketplacePage = lazy(() => import('./MarketplacePage.js').then((m) => ({ default: m.MarketplacePage })));

const routes: FeatureRoute[] = [
  {
    path: '/marketplace',
    element: <MarketplacePage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Marketplace',
      icon: BoxesIcon,
      hint: 'Browse + install signed feature packs',
      featureId: 'marketplace',
    },
  },
];

export const marketplaceFeature: FrontendFeature = { id: 'marketplace', routes };
