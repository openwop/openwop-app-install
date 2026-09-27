/**
 * Cohort seat purchase (ADR 0431 P4) — a coach-shared link, NOT a nav entry:
 * there is no cohort catalog to browse, so surfacing this in the sidebar would
 * advertise a destination with nothing behind it.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SeatPurchasePage = lazy(() => import('./SeatPurchasePage.js').then((m) => ({ default: m.SeatPurchasePage })));

const routes: FeatureRoute[] = [
  {
    path: '/kicktodo/seats/:productId',
    element: <SeatPurchasePage />,
    tier: 'workspace', archetype: 'detail',
    // No `nav` — reachable only by the shared link.
  },
];

export const kicktodoSeatsFeature: FrontendFeature = { id: 'kicktodo-commerce', routes };
