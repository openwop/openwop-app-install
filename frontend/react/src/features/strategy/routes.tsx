/**
 * Strategy frontend routes (ADR 0079; routing correction). The nav-gated
 * portfolio page + a per-strategy detail page (`/strategy/:strategyId`) — the
 * projects `/projects/:projectId` pattern, so every strategy is deep-linkable.
 */
import { lazy } from 'react';
import { FlagIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const StrategyPage = lazy(() => import('./StrategyPage.js').then((m) => ({ default: m.StrategyPage })));
const StrategyDetailPage = lazy(() => import('./StrategyDetailPage.js').then((m) => ({ default: m.StrategyDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/strategy',
    element: <StrategyPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Planning',
      label: 'Strategy', labelKey: 'strategyLabel',
      icon: FlagIcon,
      hint: 'Define & align company strategy', hintKey: 'strategyHint',
      order: 36,
      featureId: 'strategy',
    },
  },
  { path: '/strategy/:strategyId', element: <StrategyDetailPage />, tier: 'workspace' , archetype: 'detail',},
];

export const strategyFeature: FrontendFeature = { id: 'strategy', routes };
