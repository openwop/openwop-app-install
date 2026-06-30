/**
 * ADR 0130 Phase 5 — Model Router frontend feature. Appended to FRONTEND_FEATURES; the
 * admin rule-manager nav is always-on (the `model-router` toggle graduated 2026-06-24;
 * admin-tier gated). Lazy route-split (off the chat entry chunk).
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { lazy } from 'react';
import { WorkflowIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ModelRouterPage = lazy(() => import('./ModelRouterPage.js').then((m) => ({ default: m.ModelRouterPage })));

const routes: FeatureRoute[] = [
  {
    path: '/model-router',
    element: <ModelRouterPage />,
    tier: 'admin',
    nav: {
      // ADR 0145 — a model concern; sits in Platform (with the leaderboard) when
      // the Models console is OFF, and is subsumed by it when ON.
      group: 'Platform',
      label: 'Model routing',
      icon: WorkflowIcon,
      hint: 'Route each chat turn to a provider/model by rule',
      // ADR 0145 — subsumed by the Models console once `models` is enabled.
      hiddenWhenFeature: 'models',
    },
    // ADR 0145 — also a tab in the Models console (/models). Always-on surface,
    // so no `featureId` gate on the tab.
    hubTab: { hub: 'models', order: 1 },
  },
];

export const modelRouterFeature: FrontendFeature = { id: 'model-router', routes };
