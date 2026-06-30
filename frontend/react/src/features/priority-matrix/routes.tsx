/**
 * Priority Matrix frontend routes (ADR 0058). One workspace-tier page, nav-gated
 * on the `priority-matrix` toggle.
 */
import { lazy } from 'react';
import { ListOrderedIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PriorityMatrixPage = lazy(() => import('./PriorityMatrixPage.js').then((m) => ({ default: m.PriorityMatrixPage })));

const routes: FeatureRoute[] = [
  {
    path: '/priority-matrix',
    element: <PriorityMatrixPage />,
    tier: 'workspace',
    nav: {
      group: 'Leadership',
      label: 'Priority Matrix',
      icon: ListOrderedIcon,
      hint: 'Score & rank ideas, plan sessions',
      order: 37,
      featureId: 'priority-matrix',
    },
  },
];

export const priorityMatrixFeature: FrontendFeature = { id: 'priority-matrix', routes };
