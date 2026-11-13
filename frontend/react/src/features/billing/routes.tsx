/**
 * Billing frontend feature (ADR 0176) — route + nav (admin tier). featureId-gated on
 * the `billing` toggle; lazy page.
 *
 * ADR 1097 — plus ONE public page, `/start-trial`, declared through the ADR 0630
 * `publicRoutes` seam so it renders in the bare PublicShell for signed-out
 * visitors, and a distribution without billing has no trial page either.
 */
import { lazy } from 'react';
import { BuildingIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';
import { matchStartTrialRoute } from './startTrialMatch.js';

const BillingPage = lazy(() => import('./BillingPage.js').then((m) => ({ default: m.BillingPage })));
const StartTrialPage = lazy(() => import('./StartTrialPage.js').then((m) => ({ default: m.StartTrialPage })));

const routes: FeatureRoute[] = [
  {
    path: '/billing',
    element: <BillingPage />,
    tier: 'admin', archetype: 'admin',
    nav: { group: 'Billing & commerce', labelKey: 'billingLabel', icon: BuildingIcon, hintKey: 'billingHint', order: 80, featureId: 'billing' },
  },
];

export const billingFeature: FrontendFeature = {
  id: 'billing',
  routes,
  publicRoutes: [{ match: matchStartTrialRoute, render: () => <StartTrialPage /> }],
};
