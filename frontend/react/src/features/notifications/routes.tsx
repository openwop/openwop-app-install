/**
 * Notifications frontend feature (ADR 0010). The `/inbox` route + nav entry.
 * Notifications is CORE platform infrastructure (the toggle was removed
 * 2026-06-11 — see docs/adr/0010-notifications.md § Correction), so the Inbox
 * nav carries **no `featureId`** and always shows; the per-user preferences are
 * the control. The page component stays under `src/notifications/`.
 */
import { lazy } from 'react';
import { Navigate } from 'react-router-dom';

// P4 continuation — this page's walkthrough spotlight (lazy chunk, boot-eager trigger).
void import('../../walkthroughs/pageSpotlight.js').then((m) => m.registerPageSpotlight('inbox.page.view', '/inbox', 'inbox.page'));
import { InboxIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const NotificationsPage = lazy(() => import('../../notifications/NotificationsPage.js').then((m) => ({ default: m.NotificationsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/inbox',
    element: <NotificationsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Pinned',
      labelKey: 'notificationsLabel',
      icon: InboxIcon,
      hintKey: 'notificationsHint',
      // IA refresh: the action portal sits just under Chat (order 15) — "what
      // needs me" is a daily return surface, ahead of Agents (management, 20).
      order: 15,
    },
  },
  // NYI-EMAIL-1 — email send-approval notifications delivered before #5504 link to
  // `/approvals`, which was never a route ("Page not found"). Notifications are stored, so
  // the link outlives the fix; this shim sends it to the inbox. No nav entry.
  { path: '/approvals', element: <Navigate to="/inbox" replace />, tier: 'workspace', archetype: 'standard-index' },
];

export const notificationsFeature: FrontendFeature = { id: 'notifications', routes };
