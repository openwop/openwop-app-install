/**
 * Brand frontend routes (ADR 0155 + ADR 0170). One workspace-tier page for managing
 * marketing brands, under the "Marketing" nav group. **Always-on** (no `featureId`)
 * since brand graduated to core (ADR 0170) — same as CMS (ADR 0027). The app's own
 * identity is edited separately at Admin → Appearance (Phase 6), not here.
 */
import { lazy } from 'react';
import { MegaphoneIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const BrandPage = lazy(() => import('./BrandPage.js').then((m) => ({ default: m.BrandPage })));

const routes: FeatureRoute[] = [
  {
    path: '/brand',
    element: <BrandPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Brand', labelKey: 'brandLabel',
      icon: MegaphoneIcon,
      hint: 'Define & enforce brand voice', hintKey: 'brandHint',
      order: 10,
    },
  },
];

export const brandFeature: FrontendFeature = { id: 'brand', routes };
