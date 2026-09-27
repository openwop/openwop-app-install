/**
 * kicktodo-engagement frontend manifest (ADR 0425 P4): the leaderboard +
 * awards page inside the existing KickTodo nav group, server-authoritatively
 * gated on the `kicktodo-engagement` toggle.
 */
import { lazy } from 'react';
import { StarIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const EngagementPage = lazy(() => import('./EngagementPage.js').then((m) => ({ default: m.EngagementPage })));

const routes: FeatureRoute[] = [
  {
    path: '/leaderboard',
    element: <EngagementPage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Leaderboard', labelKey: 'navLabel',
      icon: StarIcon,
      hint: 'Opt-in leaderboard and awards', hintKey: 'navHint',
      order: 40,
      featureId: 'kicktodo-engagement',
    },
  },
];

export const kicktodoEngagementFeature: FrontendFeature = { id: 'kicktodo-engagement', routes };
