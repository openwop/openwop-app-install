/**
 * Billing frontend feature (ADR 0176) — route + nav (admin tier). featureId-gated on
 * the `billing` toggle; lazy page.
 */
import { lazy } from 'react';
import { BuildingIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const BillingPage = lazy(() => import('./BillingPage.js').then((m) => ({ default: m.BillingPage })));

const routes: FeatureRoute[] = [
  {
    path: '/billing',
    element: <BillingPage />,
    tier: 'admin', archetype: 'admin',
    nav: { group: 'Billing & commerce', label: 'Billing', labelKey: 'billingLabel', icon: BuildingIcon, hint: 'Plan & token balance', hintKey: 'billingHint', order: 80, featureId: 'billing' },
  },
];

export const billingFeature: FrontendFeature = { id: 'billing', routes };
