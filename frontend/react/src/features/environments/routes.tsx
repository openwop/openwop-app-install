/** Environments feature routes (ADR 0387 Phase 5) — admin tier. */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';
import { ArrowUpToLineIcon } from '../../ui/icons/index.js';

const EnvironmentsPage = lazy(() => import('./EnvironmentsPage.js').then((m) => ({ default: m.EnvironmentsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/environments',
    element: <EnvironmentsPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      // 'Developer' (with UI Plugins) — config promotion/rollback is a
      // developer-workflow surface, not a general admin one.
      group: 'Developer',
      label: 'Environments',
      labelKey: 'environmentsLabel',
      icon: ArrowUpToLineIcon,
      hint: 'Config promotion & rollback',
      hintKey: 'environmentsHint',
      featureId: 'environments',
    },
  },
];

export const environmentsFeature: FrontendFeature = { id: 'environments', routes };
