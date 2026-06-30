import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const LeaderboardPage = lazy(() => import('./LeaderboardPage.js').then((m) => ({ default: m.LeaderboardPage })));

const routes: FeatureRoute[] = [
  {
    path: '/leaderboard',
    element: <LeaderboardPage />,
    tier: 'admin',
    nav: {
      group: 'Platform',
      label: 'Model leaderboard',
      icon: ActivityIcon,
      hint: 'Model quality from feedback',
      // evals re-graduated to toggle-gated (PR #895) — gate the nav so a disabled
      // feature doesn't appear in the rail.
      featureId: 'evals',
      // ADR 0145 — subsumed by the Models console once `models` is enabled.
      hiddenWhenFeature: 'models',
    },
    // ADR 0145 — also a tab in the Models console (/models). Gated on the same
    // `evals` toggle as the nav, so a disabled feature shows in neither the rail
    // nor the console (consistent gating, no disabled-but-clickable tab).
    hubTab: { hub: 'models', order: 2, featureId: 'evals' },
  },
];

export const evalsFeature: FrontendFeature = { id: 'evals', routes };
