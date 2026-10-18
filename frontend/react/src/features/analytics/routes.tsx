import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AnalyticsPage = lazy(() => import('./AnalyticsPage.js').then((m) => ({ default: m.AnalyticsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/analytics',
    element: <AnalyticsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      // ADR 0892 — Analytics measures the public site (CMS pages, the paywall
      // funnel), not CRM, and stays on when CRM is off; it lives in the
      // always-present Marketing group so an opt-in CRM leaves no orphan group.
      group: 'Marketing',
      label: 'Analytics', labelKey: 'analyticsLabel',
      icon: ActivityIcon,
      hint: 'Traffic + conversions on the public surface', hintKey: 'analyticsHint',
      featureId: 'analytics',
    },
  },
];

export const analyticsFeature: FrontendFeature = { id: 'analytics', routes };
