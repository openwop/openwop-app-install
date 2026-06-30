/**
 * Connections frontend feature — route + nav fragment (ADR 0024).
 * Appended to FRONTEND_FEATURES. Connections graduated off its feature toggle
 * on 2026-06-11 (ADR 0024 § Correction): permanent admin surface, so the nav
 * is `tier: 'admin'` (renders in the AdminLayout rail's "Access & data" group)
 * and carries no `featureId` gate.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ConnectionsPage = lazy(() => import('./ConnectionsPage.js').then((m) => ({ default: m.ConnectionsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/connections',
    element: <ConnectionsPage />,
    tier: 'admin',
    // ADR 0144 §Correction (2026-06-26) — reached only via the always-on Access
    // Hub; no standalone nav. Route + hubTab stay (the hub renders the element).
    hubTab: { group: 'credentials', order: 1, scopes: ['workspace', 'personal'] },
  },
];

export const connectionsFeature: FrontendFeature = { id: 'connections', routes };
