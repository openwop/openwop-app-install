/**
 * Dealer Network frontend feature (ADR 0281) — route + nav manifest.
 * Registered into FRONTEND_FEATURES; the nav entry carries `featureId: 'dealers'`
 * so it hides unless the toggle resolves enabled.
 */
import { lazy } from 'react';
import { BuildingIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DealersPage = lazy(() => import('./DealersPage.js').then((m) => ({ default: m.DealersPage })));
const OutletDetailPage = lazy(() => import('./OutletDetailPage.js').then((m) => ({ default: m.OutletDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/dealers',
    element: <DealersPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Sales',
      label: 'Dealers', labelKey: 'dealersLabel',
      icon: BuildingIcon,
      hint: 'Dealer network, outlets & partner registrations', hintKey: 'dealersHint',
      order: 49,
      featureId: 'dealers',
    },
  },
  // Outlet detail — the sales-map pin deep-link target (no nav entry; reached by
  // URL). The page itself gates on the `dealers` toggle (ADR 0336 pattern).
  {
    path: '/dealers/outlets/:outletId',
    element: <OutletDetailPage />,
    tier: 'workspace', archetype: 'detail',
  },
];

export const dealersFeature: FrontendFeature = { id: 'dealers', routes };
