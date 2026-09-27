/**
 * Campaign Brief frontend routes (ADR 0156). One workspace-tier page (Briefs +
 * Personas tabs) under the "Marketing" nav group — second of the Campaign Studio
 * cluster.
 */
import { lazy } from 'react';
import { ClipboardIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignBriefPage = lazy(() => import('./CampaignBriefPage.js').then((m) => ({ default: m.CampaignBriefPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaign-brief',
    element: <CampaignBriefPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Campaign Briefs', labelKey: 'campaignBriefLabel',
      icon: ClipboardIcon,
      hint: 'Personas, briefs & the messaging kernel', hintKey: 'campaignBriefHint',
      order: 20,
      featureId: 'campaign-brief',
      // ADR 0200 Phase 2 — collapse into the Campaign Studio console when `campaigns` is on.
      hiddenWhenFeature: 'campaigns',
    },
    hubTab: { hub: 'campaigns', order: 1, featureId: 'campaign-brief' },
  },
];

export const campaignBriefFeature: FrontendFeature = { id: 'campaign-brief', routes };

// ADR 0368 Phase 4 — the reference tour's semantic targets register with the
// feature that owns them. DYNAMIC import: the registration module must stay
// out of the entry chunk (the 188 kB budget); it settles long before any
// tour can run.
void import('./walkthroughActions.js').then((m) => m.registerCampaignStudioWalkthroughActions());
