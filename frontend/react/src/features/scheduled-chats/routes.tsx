import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ScheduledChatsPage = lazy(() => import('./ScheduledChatsPage.js').then((m) => ({ default: m.ScheduledChatsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/scheduled-chats',
    element: <ScheduledChatsPage />,
    tier: 'admin',
    nav: {
      group: 'Platform',
      label: 'Scheduled chats',
      icon: ActivityIcon,
      hint: 'Recurring agent chats',
      // scheduled-chats re-graduated to toggle-gated (PR #895) — gate the nav so a
      // disabled feature doesn't appear in the rail.
      featureId: 'scheduled-agent-chats',
      // ADR 0145 — subsumed by the Chat deployment console once enabled.
      hiddenWhenFeature: 'chat-deployment',
    },
    // ADR 0145 — also a tab in the Chat deployment console. Gated on the same
    // `scheduled-agent-chats` toggle as the nav, so a disabled feature shows in
    // neither the rail nor the console (consistent gating).
    hubTab: { hub: 'chat-deployment', order: 1, featureId: 'scheduled-agent-chats' },
  },
];

export const scheduledChatsFeature: FrontendFeature = { id: 'scheduled-chats', routes };
