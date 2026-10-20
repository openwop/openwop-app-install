/**
 * ADR 0137 — Ambient Work Graph frontend feature. Appended to FRONTEND_FEATURES; the nav
 * is always-on (toggle removed, 2026-06-24). WORKSPACE tier since ADR 0930 (grade-ux
 * AWG2UX-1): the patterns are each member's own, so an admin-only route hid every
 * member's own data from them, and its nav group moved with it to "Workspace" (ADR 0145
 * had filed it under the admin "Operations" group beside Runs / Library, which is right
 * for an admin read-model and wrong for a person's own patterns). Lazy route-split (off
 * the chat entry chunk).
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
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      label: 'Work patterns', labelKey: 'ambientWorkGraphLabel',
      icon: SparklesIcon,
      hint: 'Recurring work → suggested workflows', hintKey: 'ambientWorkGraphHint',
    },
  },
];

export const ambientWorkGraphFeature: FrontendFeature = { id: 'ambient-work-graph', routes };
