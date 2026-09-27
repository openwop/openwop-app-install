/**
 * Funnels frontend feature (ADR 0294 / Funnel A) — route + nav fragment.
 * Appended to FRONTEND_FEATURES; nav gated by `featureId: 'funnels'`.
 */
import { lazy } from 'react';

// ADR 0378 P4 — the funnels walkthrough action pack, lazy chunk + boot-eager trigger.
void import('./walkthroughActions.js').then((m) => m.registerFunnelsWalkthroughActions());
import { ListOrderedIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const FunnelsPage = lazy(() => import('./FunnelsPage.js').then((m) => ({ default: m.FunnelsPage })));
const FunnelDetailPage = lazy(() => import('./FunnelDetailPage.js').then((m) => ({ default: m.FunnelDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/funnels',
    element: <FunnelsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Marketing', label: 'Funnels', labelKey: 'funnelsLabel', icon: ListOrderedIcon, hint: 'Multi-step sales funnels', hintKey: 'funnelsHint', order: 63, featureId: 'funnels' },
  },
  // ADR 0522 — the step editor / analytics / experiments live at the funnel's
  // OWN URL (§4.5 rule 12), not stacked under the table behind `?funnel=`.
  { path: '/funnels/:funnelId', element: <FunnelDetailPage />, tier: 'workspace', archetype: 'detail' },
];

export const funnelsFeature: FrontendFeature = { id: 'funnels', routes };
