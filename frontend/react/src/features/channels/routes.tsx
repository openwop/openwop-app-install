import { Navigate, useParams } from 'react-router-dom';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

/**
 * ADR 0154 Phase 3 — the standalone `/channels` page is RETIRED. Channels now
 * live in the unified chat rail (Phase 1: a "Channels" section + ConversationView)
 * with management as chat chrome (Phase 2: create dialog + settings dialog). This
 * supersedes ADR 0145 §4 (Channels as a workspace-nav destination).
 *
 * These thin redirects preserve old deep links — `/channels` → the chat (where the
 * Channels rail section is), `/channels/:id` → the chat scoped to that channel via
 * the existing `?conversation=` deep-link. There is NO nav entry: the rail IS the
 * surface. Reversible by restoring the page route.
 */
function ChannelDeepLinkRedirect(): JSX.Element {
  const { channelId } = useParams();
  return <Navigate to={channelId ? `/?conversation=${encodeURIComponent(channelId)}` : '/'} replace />;
}

const routes: FeatureRoute[] = [
  // Reachable routes with no `nav` — redirect shims, not menu destinations.
  { path: '/channels', element: <Navigate to="/" replace />, tier: 'workspace' },
  { path: '/channels/:channelId', element: <ChannelDeepLinkRedirect />, tier: 'workspace' },
];

export const channelsFeature: FrontendFeature = { id: 'channels', routes };
