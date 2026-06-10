/**
 * Notifications frontend feature (ADR 0010 Phase 3). The `/inbox` route +
 * nav entry, migrated out of chrome/features.tsx's CORE_FEATURES into the
 * feature registry. Nav-gated on the `notifications` toggle, so an admin who
 * turns the feature off removes the Inbox nav item (the header bell is gated
 * separately in chrome/Sidebar.tsx). The page component itself stays under
 * `src/notifications/` — a faithful migration wraps it, it isn't moved.
 */
import { lazy } from 'react';
import { InboxIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const NotificationsPage = lazy(() => import('../../notifications/NotificationsPage.js').then((m) => ({ default: m.NotificationsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/inbox',
    element: <NotificationsPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Inbox',
      icon: InboxIcon,
      hint: 'Notifications + approvals',
      featureId: 'notifications',
    },
  },
];

export const notificationsFeature: FrontendFeature = { id: 'notifications', routes };
