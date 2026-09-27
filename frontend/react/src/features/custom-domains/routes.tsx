/**
 * Custom-domains frontend feature (ADR 0295 / FNL-UX-3) — route + nav fragment.
 * Nav gated by `featureId: 'custom-domains'`.
 */
import { lazy } from 'react';
import { GlobeIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DomainsPage = lazy(() => import('./DomainsPage.js').then((m) => ({ default: m.DomainsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/domains',
    element: <DomainsPage />,
    // Admin tier (product ruling 2026-07-06): domain wiring is operator
    // infrastructure, not a day-to-day workspace surface.
    tier: 'admin', archetype: 'admin',
    nav: { group: 'Deployment & customization', label: 'Custom domains', labelKey: 'customDomainsLabel', icon: GlobeIcon, hint: 'Serve published content on your own hostname', hintKey: 'customDomainsHint', order: 64, featureId: 'custom-domains' },
  },
];

export const customDomainsFeature: FrontendFeature = { id: 'custom-domains', routes };
