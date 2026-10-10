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
      // ADR 0820 §8.2 — `scheduled-agent-chats` has a toggle again (default ON,
      // Agents bundle), so this gate names a LIVE toggle. Until then it named a
      // retired id, which hid the rail item for everyone (core-audit M5).
      featureId: 'scheduled-agent-chats',
      // ADR 0145 — subsumed by the Chat deployment console once enabled.
      hiddenWhenFeature: 'chat-deployment',
    },
    // ADR 0145 — also a tab in the Chat deployment console, gated on the same
    // toggle as the nav. ADR 0719 D1 had removed this `featureId` because the id
    // was then RETIRED (an absent `/assignments` entry hid the tab for everyone);
    // ADR 0820 §8.2 restores the toggle, so the gate is honest again.
    hubTab: { hub: 'chat-deployment', order: 1, featureId: 'scheduled-agent-chats' },
  },
];

// ADR 0820 §8.6 (core-audit M6) — ONE id for one feature: this frontend half is
// `scheduled-agent-chats`, the backend package's id, so the catalog, the paywall
// and the distribution builder all name the same thing. (It was `scheduled-chats`,
// a second, toggle-less id that could never be sold.)
export const scheduledAgentChatsFeature: FrontendFeature = { id: 'scheduled-agent-chats', routes };
