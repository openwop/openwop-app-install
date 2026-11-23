/**
 * Sends a signed-in visitor to the configured app home (`chrome/appHome.ts`).
 *
 * Rendered by the app shell's `/` (`RootRedirect`) and by `APP_HOME_ENTRY`, the
 * target of "Open app" when `VITE_BRAND_APP_HOME_PATH` is set. Both sit inside
 * `FeatureAccessProvider`, so the feature's toggle is known before the visitor
 * moves: it waits for the toggle read, then goes to the configured path, or to
 * `/dashboard` when that path is not a registered, enabled, unlocked route.
 *
 * Loaded lazily, and only when a home path is configured: it imports the route
 * manifest, which the dashboard routes cannot import statically (a cycle).
 */
import { Navigate } from 'react-router-dom';
import { Skeleton } from '../ui/Skeleton.js';
import { useAllFeatureAccess, useFeatureLocked } from '../featureToggles/FeatureAccessContext.js';
import { CONFIGURED_APP_HOME, resolveAppHome } from './appHome.js';
import { featureFor } from './features.js';

export function AppHomeRedirect({ configured = CONFIGURED_APP_HOME }: { configured?: string }): JSX.Element {
  const { byId, loading, resolutionFailed } = useAllFeatureAccess();
  const locked = useFeatureLocked();
  if (loading) return <div className="u-p-4" role="status"><Skeleton /></div>;
  const to = resolveAppHome(configured, featureFor(configured), {
    enabled: (id) => byId[id]?.enabled,
    locked,
    resolutionFailed,
  });
  return <Navigate to={to} replace />;
}

export default AppHomeRedirect;
