/**
 * Experiments frontend feature (ADR 0949 P2b) — route + nav fragment. Both
 * pages are lazy chunks; the nav entry is gated by `featureId: 'experiments'`.
 */
import { lazy } from 'react';
import { FlaskIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ExperimentsPage = lazy(() => import('./ExperimentsPage.js').then((m) => ({ default: m.ExperimentsPage })));
const ExperimentDetailPage = lazy(() => import('./ExperimentDetailPage.js').then((m) => ({ default: m.ExperimentDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/experiments',
    element: <ExperimentsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Marketing', label: 'Experiments', labelKey: 'experimentsLabel', icon: FlaskIcon, hint: 'Pre-registered A/B tests', hintKey: 'experimentsHint', order: 64, featureId: 'experiments' },
  },
  { path: '/experiments/:experimentId', element: <ExperimentDetailPage />, tier: 'workspace', archetype: 'detail' },
];

export const experimentsFeature: FrontendFeature = { id: 'experiments', routes };
