/**
 * Dashboard frontend routes (ADR 0375 Phase 2; § Corrections 2026-07-16, 2026-07-25).
 *
 * § Correction (2026-07-25, ADR 0487): '/' is now ALWAYS the public marketing
 * home (App.tsx renders it in PublicShell), so the Dashboard owns its own stable
 * '/dashboard' URL and leads the pinned nav cluster. A signed-in visitor who
 * reaches the app shell at '/' is redirected to '/dashboard'. This reverses the
 * 2026-07-16 "dashboard graduated to '/'" decision — the dual-purpose root URL
 * (marketing vs app at the same path, gated by an `app-entered` marker) was
 * fragile and could strand logged-out visitors on the dashboard.
 *
 * Legacy chat deep links: '/?conversation=…' / '/?agent=…' / '/?new=…' were
 * chat-at-'/' URLs (stored notification actionUrls, bookmarks, emails). The '/'
 * element still forwards any such query to '/chat' — an old link must never
 * dead-end on a different surface.
 */
import { lazy } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LayoutGridIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';
// ADR 0487 — the legacy chat deep-link param set is shared with App.tsx's root
// gate (ONE definition, so the gate and this forwarder can never disagree).
import { LEGACY_CHAT_PARAMS } from '../../chrome/rootRoute.js';

const DashboardPage = lazy(() => import('./DashboardPage.js').then((m) => ({ default: m.DashboardPage })));

/** The app-shell '/' element (ADR 0487). Anonymous visitors never reach it ('/'
 *  renders the public marketing home in App.tsx); a signed-in visitor who lands
 *  on '/' is sent to the dashboard's own URL. Legacy chat deep links forward to
 *  '/chat' first (the contract is load-bearing — stored notification actionUrls).
 *  Exported for the route test. */
export function RootRedirect(): JSX.Element {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (LEGACY_CHAT_PARAMS.some((p) => params.has(p))) {
    return <Navigate to={`/chat${search}`} replace />;
  }
  return <Navigate to="/dashboard" replace />;
}

const routes: FeatureRoute[] = [
  {
    path: '/dashboard',
    element: <DashboardPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Pinned',
      label: 'Dashboard', labelKey: 'dashboardLabel',
      icon: LayoutGridIcon,
      hint: 'Your customizable home', hintKey: 'dashboardHint',
      order: 5, // leads the pinned cluster (Dashboard · Chat · Inbox · Agents)
      end: true,
    },
  },
  // '/' in the app shell → the dashboard (public marketing owns '/' for anon).
  { path: '/', element: <RootRedirect />, tier: 'workspace' , archetype: 'standard-index',},
];

export const dashboardFeature: FrontendFeature = { id: 'dashboard', routes };
