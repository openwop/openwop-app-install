/**
 * Campaign Studio frontend routes (ADR 0158). One workspace-tier Campaigns page
 * under the "Marketing" nav group — the heart of the Campaign Studio cluster.
 */
import { lazy } from 'react';
import { MegaphoneIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignStudioPage = lazy(() => import('./CampaignStudioPage.js').then((m) => ({ default: m.CampaignStudioPage })));
const CampaignDetailPage = lazy(() => import('./CampaignDetailPage.js').then((m) => ({ default: m.CampaignDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaigns',
    element: <CampaignStudioPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Campaigns', labelKey: 'campaignOrchestrationLabel',
      icon: MegaphoneIcon,
      hint: 'Run & manage marketing campaigns', hintKey: 'campaignOrchestrationHint',
      order: 30,
      featureId: 'campaign-orchestration',
      // ADR 0200 Phase 2 — collapse into the Campaign Studio console when `campaigns` is on.
      hiddenWhenFeature: 'campaigns',
    },
    hubTab: { hub: 'campaigns', order: 2, featureId: 'campaign-orchestration' },
  },
  {
    // ADR 0941 D5 — the campaign detail, two segments under the console. Its
    // parent is `/campaigns`, which is reachable whenever this feature is on
    // (the `/campaign-studio` hub is gated by the separate `campaigns` toggle).
    path: '/campaign-studio/campaigns/:campaignId',
    element: <CampaignDetailPage />,
    tier: 'workspace', archetype: 'detail',
    parentPath: '/campaigns',
  },
];

export const campaignOrchestrationFeature: FrontendFeature = { id: 'campaign-orchestration', routes };
