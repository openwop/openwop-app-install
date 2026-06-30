/**
 * Campaign Intelligence frontend routes (ADR 0160). One workspace-tier page under
 * the "Marketing" nav group — the analysis layer (budget + forecast + Analyst).
 */
import { lazy } from 'react';
import { SparklesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignIntelPage = lazy(() => import('./CampaignIntelPage.js').then((m) => ({ default: m.CampaignIntelPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaign-intelligence',
    element: <CampaignIntelPage />,
    tier: 'workspace',
    nav: {
      group: 'Marketing',
      label: 'Intelligence',
      icon: SparklesIcon,
      hint: 'Budget & forecast recommendations',
      order: 50,
      featureId: 'campaign-intel',
    },
  },
];

export const campaignIntelFeature: FrontendFeature = { id: 'campaign-intel', routes };
