/**
 * Marketplace frontend feature — route + nav fragment (ADR 0022). Appended to
 * FRONTEND_FEATURES; nav gated by `featureId: 'marketplace'`.
 */
import { lazy } from 'react';
import { BoxesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MarketplacePage = lazy(() => import('./MarketplacePage.js').then((m) => ({ default: m.MarketplacePage })));
const BundleShopPage = lazy(() => import('./BundleShopPage.js').then((m) => ({ default: m.BundleShopPage })));

const routes: FeatureRoute[] = [
  // ADR 0366 P3 — the bundle shop: linked from the marketplace page, no
  // separate nav entry (one Marketplace nav item stays the wayfinding truth).
  {
    path: '/marketplace/bundles',
    element: <BundleShopPage />,
    tier: 'admin', archetype: 'admin',
  },
  {
    path: '/marketplace',
    element: <MarketplacePage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Developer',
      label: 'Marketplace', labelKey: 'marketplaceLabel',
      icon: BoxesIcon,
      hint: 'Browse + install signed feature packs', hintKey: 'marketplaceHint',
      featureId: 'marketplace',
    },
  },
];

export const marketplaceFeature: FrontendFeature = { id: 'marketplace', routes };
