/** Commerce Connect (ADR 0385) — feature routes + nav. */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';
import { PackageIcon } from '../../ui/icons/index.js';

const CommerceConnectPage = lazy(() => import('./CommerceConnectPage.js').then((m) => ({ default: m.CommerceConnectPage })));

const routes: FeatureRoute[] = [{
  path: '/commerce-connect',
  element: <CommerceConnectPage />,
  tier: 'admin', archetype: 'admin',
  nav: {
    group: 'Billing & commerce',
    label: 'Sell on the marketplace',
    labelKey: 'commerceConnectLabel',
    icon: PackageIcon,
    hint: 'Stripe Connect seller onboarding',
    hintKey: 'commerceConnectHint',
    order: 82,
    featureId: 'commerce-connect',
  },
}];

export const commerceConnectFeature: FrontendFeature = { id: 'commerce-connect', routes };
