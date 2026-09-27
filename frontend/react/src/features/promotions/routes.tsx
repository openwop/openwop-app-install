/**
 * Promotions frontend feature (ADR 0274 / MERCH-B) — route + nav fragment.
 * Appended to FRONTEND_FEATURES; nav gated by `featureId: 'promotions'`.
 */
import { lazy } from 'react';
import { ZapIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PromotionsPage = lazy(() => import('./PromotionsPage.js').then((m) => ({ default: m.PromotionsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/promotions',
    element: <PromotionsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Commerce', label: 'Promotions', labelKey: 'promotionsLabel', icon: ZapIcon, hint: 'Promotions & loss-leaders', hintKey: 'promotionsHint', order: 62, featureId: 'promotions' },
  },
];

export const promotionsFeature: FrontendFeature = { id: 'promotions', routes };
