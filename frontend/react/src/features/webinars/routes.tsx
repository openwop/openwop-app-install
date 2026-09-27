/**
 * Webinars frontend routes (ADR 0404 §a) — the webinar-event dashboard under the
 * "Marketing" nav group, gated on the `webinars` toggle.
 */
import { lazy } from 'react';
import { MegaphoneIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const WebinarsPage = lazy(() => import('./WebinarsPage.js').then((m) => ({ default: m.WebinarsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/webinars',
    element: <WebinarsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Webinars', labelKey: 'webinarsLabel',
      icon: MegaphoneIcon,
      hint: 'Zoom webinars → CRM attendance', hintKey: 'webinarsHint',
      order: 45,
      featureId: 'webinars',
    },
  },
];

export const webinarsFeature: FrontendFeature = { id: 'webinars', routes };
