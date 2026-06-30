import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const WidgetsPage = lazy(() => import('./WidgetsPage.js').then((m) => ({ default: m.WidgetsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/widgets',
    element: <WidgetsPage />,
    tier: 'admin',
    nav: {
      group: 'Platform',
      label: 'Chat widgets',
      icon: ActivityIcon,
      hint: 'Embeddable chat widgets',
      // ADR 0145 — subsumed by the Chat deployment console once enabled.
      hiddenWhenFeature: 'chat-deployment',
    },
    // ADR 0145 — also a tab in the Chat deployment console. Always-on surface, so
    // no `featureId` gate on the tab.
    hubTab: { hub: 'chat-deployment', order: 2 },
  },
];

export const chatWidgetFeature: FrontendFeature = { id: 'chat-widget', routes };
