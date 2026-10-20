/**
 * Campaign operations frontend routes (ADR 0926 D1). One workspace-tier page,
 * projected as the FIRST tab ("Operations") of the Campaign Studio hub; the
 * standalone Marketing nav entry collapses into the hub when `campaigns` is on.
 */
import { lazy } from 'react';
import { InboxIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const OperationsPage = lazy(() => import('./OperationsPage.js').then((m) => ({ default: m.OperationsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaign-ops',
    element: <OperationsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Operations', labelKey: 'campaignOpsLabel',
      icon: InboxIcon,
      hint: 'Ask for, review and approve client page changes', hintKey: 'campaignOpsHint',
      order: 29,
      featureId: 'campaign-ops',
      hiddenWhenFeature: 'campaigns',
    },
    hubTab: { hub: 'campaigns', order: 0, featureId: 'campaign-ops' },
  },
];

export const campaignOpsFeature: FrontendFeature = { id: 'campaign-ops', routes };
