/**
 * kicktodo-metrics frontend manifest (ADR 0432 P4) — admin outcome metrics,
 * server-authoritatively gated on the `kicktodo-metrics` toggle.
 */
import { lazy } from 'react';
import { BarChartIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MetricsPage = lazy(() => import('./MetricsPage.js').then((m) => ({ default: m.MetricsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/kicktodo/metrics',
    element: <MetricsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Metrics', labelKey: 'navLabel',
      icon: BarChartIcon,
      hint: 'Outcome metrics and verifier quality', hintKey: 'navHint',
      order: 80,
      featureId: 'kicktodo-metrics',
    },
  },
];

export const kicktodoMetricsFeature: FrontendFeature = { id: 'kicktodo-metrics', routes };
