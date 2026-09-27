/**
 * ADR 0130 Phase 5 — Model Router frontend feature. Appended to FRONTEND_FEATURES; the
 * admin rule-manager nav is always-on (the `model-router` toggle graduated 2026-06-24;
 * admin-tier gated). Lazy route-split (off the chat entry chunk).
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ModelRouterPage = lazy(() => import('./ModelRouterPage.js').then((m) => ({ default: m.ModelRouterPage })));

const routes: FeatureRoute[] = [
  {
    path: '/model-router',
    element: <ModelRouterPage />,
    tier: 'admin', archetype: 'admin',
    // ADR 0145 + ADR 0434 — NO standalone nav entry: the Models console is
    // always-on, so this surface is permanently subsumed by it and lives only as
    // a console tab (the ADR 0144 access-hub precedent — a graduated console's
    // subsumed surfaces drop their nav rather than keep a `hiddenWhenFeature`
    // that can never fire). The route itself stays reachable at /model-router.
    // Always-on surface, so no `featureId` gate on the tab.
    hubTab: { hub: 'models', order: 1 },
  },
];

export const modelRouterFeature: FrontendFeature = { id: 'model-router', routes };
