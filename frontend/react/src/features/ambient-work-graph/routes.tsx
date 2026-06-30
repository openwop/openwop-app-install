/**
 * ADR 0137 — Ambient Work Graph frontend feature. Appended to FRONTEND_FEATURES; the nav
 * is always-on (toggle removed, 2026-06-24). Admin-tier; ADR 0145 re-filed it from
 * "Platform" to the "Operations" group, beside the other run-derived read-models
 * (Runs / Mission Control / Library) — it mines run history for suggestions. Lazy
 * route-split (off the chat entry chunk).
 */
import { lazy } from 'react';
import { SparklesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const WorkGraphPage = lazy(() => import('./WorkGraphPage.js').then((m) => ({ default: m.WorkGraphPage })));

const routes: FeatureRoute[] = [
  {
    path: '/work-patterns',
    element: <WorkGraphPage />,
    tier: 'admin',
    nav: {
      group: 'Operations',
      label: 'Work patterns',
      icon: SparklesIcon,
      hint: 'Recurring work → suggested workflows',
    },
  },
];

export const ambientWorkGraphFeature: FrontendFeature = { id: 'ambient-work-graph', routes };
