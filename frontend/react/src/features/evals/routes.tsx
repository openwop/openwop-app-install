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
    // model-router twin). The `evals` toggle still gates the TAB, so a disabled
    // feature shows in neither the rail nor the console.
    // ADR 0719 D1 — NO `featureId`: `evals` graduated to always-on, so naming its
    // retired toggle here made `isVisible` false and hid the Leaderboard tab. See the
    // sibling note in `features/scheduled-chats/routes.tsx`.
    hubTab: { hub: 'models', order: 2 },
  },
  // ADR 0123 Phase 4c — the head-to-head arena (reached from the leaderboard;
  // no nav entry of its own). Same admin tier + evals gate as /leaderboard.
  { path: '/leaderboard/arena', element: <ArenaPage />, tier: 'admin' , archetype: 'admin',},
];

export const evalsFeature: FrontendFeature = { id: 'evals', routes };
