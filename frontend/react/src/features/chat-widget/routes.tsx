import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const WidgetsPage = lazy(() => import('./WidgetsPage.js').then((m) => ({ default: m.WidgetsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/widgets',
    element: <WidgetsPage />,
    // ADR 0610 D6 (CDC-2) — backend widget routes are `workspace:write` (chat-widget/routes.ts),
    // so the FE tier is `workspace`, not `admin`. Now a workspace-rail surface, so the `admin`
    // archetype + `Platform` (admin-only) group move to the workspace index archetype + group.
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      label: 'Chat widgets', labelKey: 'chatWidgetLabel',
      icon: ActivityIcon,
      hint: 'Embeddable chat widgets', hintKey: 'chatWidgetHint',
      // ADR 0145 — subsumed by the Chat deployment console once enabled.
      hiddenWhenFeature: 'chat-deployment',
    },
    // ADR 0145 — also a tab in the Chat deployment console. Always-on surface, so
    // no `featureId` gate on the tab.
    hubTab: { hub: 'chat-deployment', order: 2 },
  },
];

export const chatWidgetFeature: FrontendFeature = { id: 'chat-widget', routes };
