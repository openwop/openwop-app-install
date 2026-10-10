/**
 * ADR 0130 Phase 5 — Model Router frontend feature. Appended to FRONTEND_FEATURES.
 * Lazy route-split (off the chat entry chunk).
 *
 * ADR 0820 §8.2 — `model-router` has a toggle again (default ON, sold in the
 * Governance bundle), so its console tab gates on it. It also owns the `/models`
 * hub route that the retired empty `models` package used to ship (§8.3).
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';
import { modelsHubRoutes } from '../models/routes.js';

const ModelRouterPage = lazy(() => import('./ModelRouterPage.js').then((m) => ({ default: m.ModelRouterPage })));

const routes: FeatureRoute[] = [
  ...modelsHubRoutes,
  {
    path: '/model-router',
    element: <ModelRouterPage />,
    tier: 'admin', archetype: 'admin',
    // ADR 0145 + ADR 0434 — NO standalone nav entry: the Models console is
    // always-on, so this surface is permanently subsumed by it and lives only as
    // a console tab (the ADR 0144 access-hub precedent — a graduated console's
    // subsumed surfaces drop their nav rather than keep a `hiddenWhenFeature`
    // that can never fire). The route itself stays reachable at /model-router.
    // ADR 0820 §8.2 — the toggle is back, so the tab gates on it (a disabled
    // router shows no Routing tab; turns fall back to the default model).
    hubTab: { hub: 'models', order: 1, featureId: 'model-router' },
  },
];

export const modelRouterFeature: FrontendFeature = { id: 'model-router', routes };
