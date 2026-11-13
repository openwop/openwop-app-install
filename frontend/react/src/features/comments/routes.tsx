import { lazy } from 'react';
import { MessageSquareIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CommentsPage = lazy(() => import('./CommentsPage.js').then((m) => ({ default: m.CommentsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/comments',
    element: <CommentsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      labelKey: 'commentsLabel',
      icon: MessageSquareIcon,
      order: 40,
      hintKey: 'commentsHint',
      featureId: 'comments',
    },
  },
];

export const commentsFeature: FrontendFeature = { id: 'comments', routes };
