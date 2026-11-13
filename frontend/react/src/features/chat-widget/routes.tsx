import { lazy } from 'react';
import { MessageCircleIcon } from '../../ui/icons/index.js';
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
      labelKey: 'chatWidgetLabel',
      order: 55,
      icon: MessageCircleIcon,
      hintKey: 'chatWidgetHint',
      // ADR 0820 §8.2 — `chat-widget` has a toggle again (default ON, Support bundle).
      featureId: 'chat-widget',
      // ADR 0145 — subsumed by the Chat deployment console once enabled.
      hiddenWhenFeature: 'chat-deployment',
    },
    // ADR 0145 — also a tab in the Chat deployment console, gated on the same
    // toggle as the nav (ADR 0820 §8.2).
    hubTab: { hub: 'chat-deployment', order: 2, featureId: 'chat-widget' },
  },
];

export const chatWidgetFeature: FrontendFeature = { id: 'chat-widget', routes };
