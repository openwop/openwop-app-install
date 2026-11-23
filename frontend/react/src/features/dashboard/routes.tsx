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
import { CONFIGURED_APP_HOME, DEFAULT_APP_HOME_PATH } from '../../chrome/appHome.js';

const DashboardPage = lazy(() => import('./DashboardPage.js').then((m) => ({ default: m.DashboardPage })));
// Lazy: it imports the route manifest, which imports these routes (a cycle), and
// it is needed only when a brand sets VITE_BRAND_APP_HOME_PATH.
const AppHomeRedirect = lazy(() => import('../../chrome/AppHomeRedirect.js'));

/** Where a signed-in visitor lands: `/dashboard`, or the brand's configured
 *  home once it is checked against the manifest and the caller's toggles. */
function AppHome({ home }: { home: string }): JSX.Element {
  return home === DEFAULT_APP_HOME_PATH
    ? <Navigate to={DEFAULT_APP_HOME_PATH} replace />
    : <AppHomeRedirect configured={home} />;
}

/** The app-shell '/' element (ADR 0487). Anonymous visitors never reach it ('/'
 *  renders the public marketing home in App.tsx); a signed-in visitor who lands
 *  on '/' is sent to the app home (`/dashboard`, or `VITE_BRAND_APP_HOME_PATH`).
 *  Legacy chat deep links forward to '/chat' first (the contract is load-bearing
 *  — stored notification actionUrls). `home` is for the route test. */
export function RootRedirect({ home = CONFIGURED_APP_HOME }: { home?: string }): JSX.Element {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (LEGACY_CHAT_PARAMS.some((p) => params.has(p))) {
    return <Navigate to={`/chat${search}`} replace />;
  }
  return <AppHome home={home} />;
}

/** `APP_HOME_ENTRY`: the target of "Open app" when a home path is configured. */
export function AppHomeEntry({ home = CONFIGURED_APP_HOME }: { home?: string }): JSX.Element {
  return <AppHome home={home} />;
}

const routes: FeatureRoute[] = [
  {
    path: '/dashboard',
    element: <DashboardPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Pinned',
      labelKey: 'dashboardLabel',
      icon: LayoutGridIcon,
      hintKey: 'dashboardHint',
      order: 5, // leads the pinned cluster (Dashboard · Chat · Inbox · Agents)
      end: true,
    },
  },
  // '/' in the app shell → the dashboard (public marketing owns '/' for anon).
  { path: '/', element: <RootRedirect />, tier: 'workspace' , archetype: 'standard-index',},
  // "Open app" with VITE_BRAND_APP_HOME_PATH set → the checked app home. A literal
  // so check-hosting-wire-rewrites can read it; appHomeEntry.test pins it to
  // APP_HOME_ENTRY.
  { path: '/open-app', element: <AppHomeEntry />, tier: 'workspace', archetype: 'standard-index' },
];

export const dashboardFeature: FrontendFeature = { id: 'dashboard', routes };
