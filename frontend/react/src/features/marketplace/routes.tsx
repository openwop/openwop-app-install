/**
 * Marketplace frontend feature — route + nav fragment (ADR 0022). Appended to
 * FRONTEND_FEATURES; nav gated by `featureId: 'marketplace'`.
 *
 * The three routes form ONE console, the Marketplace hub (`MarketplaceHub`):
 * Feature store → Packs → Distribution. Each declares `hubTab: { hub:
 * 'marketplace' }` — that annotation IS the tab registration (ADR 0144/0145), so
 * the hub projects them with the same toggle + tier gate the rail uses. The hub is
 * path-routed: every route keeps its own URL (lock links, Stripe return URLs and
 * bookmarks are paths); each route's element is the hub, which renders the
 * matched route's page inside its chrome.
 *
 * IMPORTANT: do NOT import `FEATURES` here (the hub reads it at render time via
 * its lazy import) — `routes.tsx` is evaluated while the manifest is composed.
 */
import { lazy } from 'react';
import { BoxesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

// The pages themselves are imported by the hub's lazy chunk (`MarketplaceHub`
// `PAGES`): the manifest pays for ONE lazy import here, not four. All three
// routes share this one element type, so a tab navigation keeps the hub (and the
// focused tab) mounted and swaps only the pane.
const MarketplaceHub = lazy(() => import('./MarketplaceHub.js').then((m) => ({ default: m.MarketplaceHub })));

const routes: FeatureRoute[] = [
  // ADR 0366 P3 / ADR 0820 §7 UI — the feature store, the hub's primary tab and
  // the hub's ONE nav entry. It sits with Billing (buyers' home) rather than under
  // Developer, and lights for every tab (`activeFor` covers `/marketplace/*`).
  {
    path: '/marketplace/bundles',
    element: <MarketplaceHub />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Billing & commerce',
      label: 'Marketplace', labelKey: 'marketplaceLabel',
      icon: BoxesIcon,
      hint: 'Feature store, packs & distributions', hintKey: 'marketplaceHint',
      order: 81,
      featureId: 'marketplace',
      activeFor: ['/marketplace'],
    },
    hubTab: { hub: 'marketplace', order: 1, featureId: 'marketplace' },
  },
  // The signed-pack registry (ADR 0022). `/marketplace` stays its URL: the
  // commerce-connect pack checkout returns to `/marketplace?purchase=…`.
  {
    path: '/marketplace',
    element: <MarketplaceHub />,
    tier: 'admin', archetype: 'admin',
    hubTab: { hub: 'marketplace', order: 2, featureId: 'marketplace' },
  },
  // ADR 0820 §7 UI — the white-label composer. SAME gate it always had (this
  // `admin` tier + the `marketplace` toggle); the hub's tier filter hides the tab
  // from anyone who could not open the page.
  {
    path: '/marketplace/distribution',
    element: <MarketplaceHub />,
    tier: 'admin', archetype: 'admin',
    hubTab: { hub: 'marketplace', order: 3, featureId: 'marketplace' },
  },
];

export const marketplaceFeature: FrontendFeature = { id: 'marketplace', routes };
