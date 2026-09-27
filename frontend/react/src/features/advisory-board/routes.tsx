/**
 * Board of Advisors frontend routes (ADR 0040). One workspace-tier page, nav-
 * gated on the `advisory-board` toggle.
 */
import { lazy } from 'react';
import { ScaleIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AdvisoryBoardPage = lazy(() => import('./AdvisoryBoardPage.js').then((m) => ({ default: m.AdvisoryBoardPage })));

const routes: FeatureRoute[] = [
  {
    path: '/advisors',
    element: <AdvisoryBoardPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Planning',
      label: 'Board of Advisors', labelKey: 'advisoryBoardLabel',
      icon: ScaleIcon,
      hint: 'Councils of advisor agents', hintKey: 'advisoryBoardHint',
      order: 39,
      featureId: 'advisory-board',
    },
  },
];

export const advisoryBoardFeature: FrontendFeature = { id: 'advisory-board', routes };
