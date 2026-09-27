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
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Intelligence', labelKey: 'campaignIntelLabel',
      icon: SparklesIcon,
      hint: 'Budget & forecast recommendations', hintKey: 'campaignIntelHint',
      order: 50,
      featureId: 'campaign-intel',
      // ADR 0200 Phase 2 — collapse into the Campaign Studio console when `campaigns` is on.
      hiddenWhenFeature: 'campaigns',
    },
    hubTab: { hub: 'campaigns', order: 4, featureId: 'campaign-intel' },
  },
];

export const campaignIntelFeature: FrontendFeature = { id: 'campaign-intel', routes };
