import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const LeaderboardPage = lazy(() => import('./LeaderboardPage.js').then((m) => ({ default: m.LeaderboardPage })));
const ArenaPage = lazy(() => import('./ArenaPage.js').then((m) => ({ default: m.ArenaPage })));

const routes: FeatureRoute[] = [
  {
    path: '/leaderboard',
    element: <LeaderboardPage />,
    tier: 'admin', archetype: 'admin',
    // ADR 0145 + ADR 0434 — NO standalone nav entry: the Models console is
    // always-on, so this surface is permanently subsumed by it (see the
    // model-router twin).
    // ADR 0719 D1 removed the `featureId` because `evals` had graduated and the id
    // named a RETIRED toggle (an absent `/assignments` entry hid the tab). ADR 0820
    // §8.2 restores the toggle (default ON, Governance bundle), so the tab gates on
    // it again — a disabled `evals` shows in neither the rail nor the console.
    hubTab: { hub: 'models', order: 2, featureId: 'evals' },
  },
  // ADR 0123 Phase 4c — the head-to-head arena (reached from the leaderboard;
  // no nav entry of its own). Same admin tier + evals gate as /leaderboard.
  { path: '/leaderboard/arena', element: <ArenaPage />, tier: 'admin' , archetype: 'admin',},
];

export const evalsFeature: FrontendFeature = { id: 'evals', routes };
