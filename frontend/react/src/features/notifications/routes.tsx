/**
 * Notifications frontend feature (ADR 0010). The `/inbox` route + nav entry.
 * Notifications is CORE platform infrastructure (the toggle was removed
 * 2026-06-11 — see docs/adr/0010-notifications.md § Correction), so the Inbox
 * nav carries **no `featureId`** and always shows; the per-user preferences are
 * the control. The page component stays under `src/notifications/`.
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
      hint: 'What needs you — approvals, blockers, notifications',
      // IA refresh: the action portal sits just under Chat (order 15) — "what
      // needs me" is a daily return surface, ahead of Agents (management, 20).
      order: 15,
    },
  },
];

export const notificationsFeature: FrontendFeature = { id: 'notifications', routes };
