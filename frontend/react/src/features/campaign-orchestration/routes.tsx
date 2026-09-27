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
];

export const campaignOrchestrationFeature: FrontendFeature = { id: 'campaign-orchestration', routes };
