/**
 * Campaign Connectors frontend routes (ADR 0159). One workspace-tier Performance
 * page under the "Marketing" nav group — the campaign data + KPI layer.
 */
import { lazy } from 'react';
import { ActivityIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignConnectorsPage = lazy(() => import('./CampaignConnectorsPage.js').then((m) => ({ default: m.CampaignConnectorsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaign-performance',
    element: <CampaignConnectorsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Performance', labelKey: 'campaignConnectorsLabel',
      icon: ActivityIcon,
      hint: 'Ad performance import & KPIs', hintKey: 'campaignConnectorsHint',
      order: 40,
      featureId: 'campaign-connectors',
      // ADR 0200 Phase 2 — collapse into the Campaign Studio console when `campaigns` is on.
      hiddenWhenFeature: 'campaigns',
    },
    hubTab: { hub: 'campaigns', order: 3, featureId: 'campaign-connectors' },
  },
];

export const campaignConnectorsFeature: FrontendFeature = { id: 'campaign-connectors', routes };
