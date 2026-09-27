/**
 * UCP-buyer (agentic procurement) frontend feature — the purchases list + a
 * deep-linkable detail (deep-link ADR 0336; ADR 0258 UCP-over-MCP). Standalone
 * package gated on the `commerce-ucp-buyer` toggle (independent of the seller
 * `commerce`); registered by appending to FRONTEND_FEATURES (ADR 0001).
 */
import { lazy } from 'react';
import { PackageIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PurchasesPage = lazy(() => import('./PurchasesPage.js').then((m) => ({ default: m.PurchasesPage })));
const PurchaseDetailPage = lazy(() => import('./PurchaseDetailPage.js').then((m) => ({ default: m.PurchaseDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/commerce/purchases',
    element: <PurchasesPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Commerce', label: 'Agent purchases', labelKey: 'ucpPurchasesLabel', icon: PackageIcon, hint: 'Purchases agents placed over UCP', hintKey: 'ucpPurchasesHint', order: 61, featureId: 'commerce-ucp-buyer' },
  },
  // Deep-linkable detail (no nav; gated internally). The landing target for the
  // commerce.ucp-buyer.* notifications.
  {
    path: '/commerce/purchases/:purchaseId',
    element: <PurchaseDetailPage />,
    tier: 'workspace', archetype: 'detail',
  },
];

export const commerceUcpBuyerFeature: FrontendFeature = { id: 'commerce-ucp-buyer', routes };
