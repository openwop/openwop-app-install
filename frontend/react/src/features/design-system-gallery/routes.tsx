/**
 * Design-system gallery route (ADR 0510 Phase 2, DSA-031) — admin-tier
 * engineering surface behind the existing `developer-tools` toggle (Gate B,
 * the manual-tests ADR 0183/0196 precedent). No dedicated toggle: ADR 0510 §1
 * makes the design system always-on core infrastructure; only this inspection
 * page is gated. `/design-system` is a fresh top-level path — `/test` belongs
 * to manual-tests.
 */
import { lazy } from 'react';
import { SparklesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const GalleryPage = lazy(() => import('./GalleryPage.js').then((m) => ({ default: m.GalleryPage })));

const routes: FeatureRoute[] = [
  {
    path: '/design-system',
    element: <GalleryPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Developer',
      label: 'Design system',
      labelKey: 'designSystemLabel',
      icon: SparklesIcon,
      hint: 'Primitive + pattern gallery',
      hintKey: 'designSystemHint',
      order: 96,
      featureId: 'developer-tools',
    },
  },
];

export const designSystemGalleryFeature: FrontendFeature = { id: 'design-system-gallery', routes };
