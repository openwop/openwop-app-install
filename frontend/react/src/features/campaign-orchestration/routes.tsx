/**
 * Campaign Studio frontend routes (ADR 0158). One workspace-tier Campaigns page
 * under the "Marketing" nav group — the heart of the Campaign Studio cluster.
 */
import { lazy } from 'react';
import { MegaphoneIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignStudioPage = lazy(() => import('./CampaignStudioPage.js').then((m) => ({ default: m.CampaignStudioPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaigns',
    element: <CampaignStudioPage />,
    tier: 'workspace',
    nav: {
      group: 'Marketing',
      label: 'Campaigns',
      icon: MegaphoneIcon,
      hint: 'Run & manage marketing campaigns',
      order: 30,
      featureId: 'campaign-orchestration',
    },
  },
];

export const campaignOrchestrationFeature: FrontendFeature = { id: 'campaign-orchestration', routes };
