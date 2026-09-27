/**
 * Commerce admin frontend feature (gap plan §5C C1) — route + nav (workspace tier),
 * featureId-gated on the `commerce` toggle; lazy page. The standalone `commerce-ucp`
 * panel stays its own admin destination (endpoints/clients are operator plumbing);
 * this page is the day-to-day back office.
 */
import { lazy } from 'react';
import { PackageIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

// ADR 0488 P4 — boot-eager walkthrough action registration (funnels idiom).
void import('./walkthroughActions.js').then((m) => m.registerCommerceWalkthroughActions());

const CommercePage = lazy(() => import('./CommercePage.js').then((m) => ({ default: m.CommercePage })));
const OrderDetailPage = lazy(() => import('./OrderDetailPage.js').then((m) => ({ default: m.OrderDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/commerce',
    element: <CommercePage />,
    tier: 'workspace', archetype: 'data-dense-index',
    nav: { group: 'Commerce', label: 'Commerce', labelKey: 'commerceLabel', icon: PackageIcon, hint: 'Products, orders, quotes & pricing', hintKey: 'commerceHint', order: 60, featureId: 'commerce' },
  },
  // Deep-linkable order detail (no nav — a detail route, gated internally on the
  // `commerce` toggle). The landing target for the commerce.order.paid notification.
  {
    path: '/commerce/orders/:orderId',
    element: <OrderDetailPage />,
    tier: 'workspace', archetype: 'detail',
  },
];

export const commerceFeature: FrontendFeature = { id: 'commerce', routes };
