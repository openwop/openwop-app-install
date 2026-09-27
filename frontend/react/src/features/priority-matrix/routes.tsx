/**
 * Priority Matrix frontend routes (ADR 0058; routing correction). The nav-gated
 * portfolio page + a per-list detail page (`/priority-matrix/:listId`) — the
 * projects `/projects/:projectId` pattern, so every list is deep-linkable.
 */
import { lazy } from 'react';
import { ListOrderedIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PriorityMatrixPage = lazy(() => import('./PriorityMatrixPage.js').then((m) => ({ default: m.PriorityMatrixPage })));
const PriorityListPage = lazy(() => import('./PriorityListPage.js').then((m) => ({ default: m.PriorityListPage })));

const routes: FeatureRoute[] = [
  {
    path: '/priority-matrix',
    element: <PriorityMatrixPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Planning',
      label: 'Priority Matrix', labelKey: 'priorityMatrixLabel',
      icon: ListOrderedIcon,
      hint: 'Score & rank ideas, plan sessions', hintKey: 'priorityMatrixHint',
      order: 37,
      featureId: 'priority-matrix',
    },
  },
  { path: '/priority-matrix/:listId', element: <PriorityListPage />, tier: 'workspace' , archetype: 'detail',},
];

export const priorityMatrixFeature: FrontendFeature = { id: 'priority-matrix', routes };
