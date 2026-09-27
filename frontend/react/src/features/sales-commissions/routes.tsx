/**
 * Sales Commissions frontend feature (ADR 0280) — route + nav manifest.
 * Registered into FRONTEND_FEATURES; the nav entry carries `featureId:
 * 'sales-commissions'` so it hides unless the toggle resolves enabled.
 */
import { lazy } from 'react';
import { ScaleIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CommissionsPage = lazy(() => import('./CommissionsPage.js').then((m) => ({ default: m.CommissionsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/commissions',
    element: <CommissionsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Sales',
      label: 'Commissions', labelKey: 'commissionsLabel',
      icon: ScaleIcon,
      hint: 'Rep incentive plans & commission statements', hintKey: 'commissionsHint',
      order: 48,
      featureId: 'sales-commissions',
    },
  },
];

export const salesCommissionsFeature: FrontendFeature = { id: 'sales-commissions', routes };
