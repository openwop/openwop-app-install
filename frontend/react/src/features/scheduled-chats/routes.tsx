import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ScheduledChatsPage = lazy(() => import('./ScheduledChatsPage.js').then((m) => ({ default: m.ScheduledChatsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/scheduled-chats',
    element: <ScheduledChatsPage />,
    // ADR 0610 D6 (CDC-2) — backend is `workspace:read`/`workspace:write` (scheduled-agent-chats
    // routes.ts), so the FE tier must not over-claim `admin` (an entitled workspace:write non-admin
    // could not reach a surface the backend would serve them). Now a workspace-rail surface, so the
    // `admin` archetype + `Platform` (admin-only) group move to the workspace index archetype + group.
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      label: 'Scheduled chats', labelKey: 'scheduledChatsLabel',
      icon: ActivityIcon,
      hint: 'Recurring agent chats', hintKey: 'scheduledChatsHint',
      // scheduled-chats re-graduated to toggle-gated (PR #895) — gate the nav so a
      // disabled feature doesn't appear in the rail.
      featureId: 'scheduled-agent-chats',
      // ADR 0145 — subsumed by the Chat deployment console once enabled.
      hiddenWhenFeature: 'chat-deployment',
    },
    // ADR 0145 — also a tab in the Chat deployment console. Gated on the same
    // `scheduled-agent-chats` toggle as the nav, so a disabled feature shows in
    // neither the rail nor the console (consistent gating).
    // ADR 0719 D1 — NO `featureId`. `scheduled-agent-chats` GRADUATED to always-on, so
    // its toggle is in RETIRED_TOGGLE_IDS and never reaches `/assignments`. With the id
    // present, `useFeatureVisible` read `byId['scheduled-agent-chats']?.enabled === true`
    // against an ABSENT entry -> false -> this tab was filtered out of the console
    // entirely, and the one-remaining-destination branch then dropped the tab strip, so
    // the loss left no trace. `model-router` and `chat-widget` are graduated too and
    // correctly omit it. An always-on feature has nothing to gate on.
    hubTab: { hub: 'chat-deployment', order: 1 },
  },
];

export const scheduledChatsFeature: FrontendFeature = { id: 'scheduled-chats', routes };
