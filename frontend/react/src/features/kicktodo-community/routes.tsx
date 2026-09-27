/**
 * kicktodo-community frontend manifest (ADR 0426 P4): profile + reviews page
 * in the KickTodo nav group, gated on the `kicktodo-community` toggle.
 */
import { lazy } from 'react';
import { UsersIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CommunityPage = lazy(() => import('./CommunityPage.js').then((m) => ({ default: m.CommunityPage })));

const routes: FeatureRoute[] = [
  {
    path: '/kicktodo/community',
    element: <CommunityPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Community', labelKey: 'navLabel',
      icon: UsersIcon,
      hint: 'Creator profile and challenge reviews', hintKey: 'navHint',
      order: 50,
      featureId: 'kicktodo-community',
    },
  },
];

export const kicktodoCommunityFeature: FrontendFeature = { id: 'kicktodo-community', routes };
