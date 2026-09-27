/**
 * UCP admin frontend feature (ADR 0178 Phase 4) — route + nav (admin tier), featureId-gated
 * on the `commerce-ucp` toggle; lazy page. Standalone package because the commerce admin has
 * no frontend yet (ADR 0177 backend-only); composes in when that lands.
 */
import { lazy } from 'react';
import { PlugIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CommerceUcpPage = lazy(() => import('./CommerceUcpPage.js').then((m) => ({ default: m.CommerceUcpPage })));

const routes: FeatureRoute[] = [
  {
    path: '/commerce-ucp',
    element: <CommerceUcpPage />,
    tier: 'admin', archetype: 'admin',
    nav: { group: 'System operations', label: 'UCP commerce', labelKey: 'commerceUcpLabel', icon: PlugIcon, hint: 'Agentic-commerce endpoints & clients', hintKey: 'commerceUcpHint', order: 90, featureId: 'commerce-ucp' },
  },
];

export const commerceUcpFeature: FrontendFeature = { id: 'commerce-ucp', routes };
