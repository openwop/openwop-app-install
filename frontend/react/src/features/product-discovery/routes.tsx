/**
 * Discovery frontend feature (ADR 0275 / MERCH-C) — route + nav fragment.
 * Appended to FRONTEND_FEATURES; nav gated by `featureId: 'discovery'`.
 */
import { lazy } from 'react';
import { BoxesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DiscoveryPage = lazy(() => import('./DiscoveryPage.js').then((m) => ({ default: m.DiscoveryPage })));

const routes: FeatureRoute[] = [
  {
    path: '/discovery',
    element: <DiscoveryPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Commerce', label: 'Discovery', labelKey: 'discoveryLabel', icon: BoxesIcon, hint: 'Search, collections & merchandising', hintKey: 'discoveryHint', order: 63, featureId: 'discovery' },
  },
];

export const discoveryFeature: FrontendFeature = { id: 'product-discovery', routes };
