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
    tier: 'workspace',
    nav: {
      group: 'Marketing',
      label: 'Campaign Briefs',
      icon: ClipboardIcon,
      hint: 'Personas, briefs & the messaging kernel',
      order: 20,
      featureId: 'campaign-brief',
    },
  },
];

export const campaignBriefFeature: FrontendFeature = { id: 'campaign-brief', routes };
