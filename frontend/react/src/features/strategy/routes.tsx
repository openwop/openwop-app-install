/**
 * Strategy frontend routes (ADR 0079). One workspace-tier page, nav-gated on the
 * `strategy` toggle.
 */
import { lazy } from 'react';
import { FlagIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const StrategyPage = lazy(() => import('./StrategyPage.js').then((m) => ({ default: m.StrategyPage })));

const routes: FeatureRoute[] = [
  {
    path: '/strategy',
    element: <StrategyPage />,
    tier: 'workspace',
    nav: {
      group: 'Leadership',
      label: 'Strategy',
      icon: FlagIcon,
      hint: 'Define & align company strategy',
      order: 38,
      featureId: 'strategy',
    },
  },
];

export const strategyFeature: FrontendFeature = { id: 'strategy', routes };
