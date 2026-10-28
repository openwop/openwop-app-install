/**
 * Campaign playbooks frontend routes (ADR 0959 P5). One workspace-tier page, projected as a tab
 * of the Campaign Studio hub; the standalone Marketing nav entry collapses into the hub when
 * `campaigns` is on (the campaign-ops precedent).
 */
import { lazy } from 'react';
import { BookOpenIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PlaybooksPage = lazy(() => import('./PlaybooksPage.js').then((m) => ({ default: m.PlaybooksPage })));

const routes: FeatureRoute[] = [
  {
    path: '/campaign-playbooks',
    element: <PlaybooksPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Playbooks', labelKey: 'campaignPlaybooksLabel',
      icon: BookOpenIcon,
      hint: 'Roll out your campaign methods to every client', hintKey: 'campaignPlaybooksHint',
      order: 30,
      featureId: 'campaign-playbooks',
      hiddenWhenFeature: 'campaigns',
    },
    hubTab: { hub: 'campaigns', order: 5, featureId: 'campaign-playbooks' },
  },
];

export const campaignPlaybooksFeature: FrontendFeature = { id: 'campaign-playbooks', routes };
