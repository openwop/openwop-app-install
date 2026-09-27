/**
 * Creative-video frontend routes (ADR 0404 §b) — the AI-video affordance under
 * the "Canvas" nav group, gated on the `creative-video` toggle.
 */
import { lazy } from 'react';
import { WandIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CreativeVideoPage = lazy(() => import('./CreativeVideoPage.js').then((m) => ({ default: m.CreativeVideoPage })));

const routes: FeatureRoute[] = [
  {
    path: '/ai-video',
    element: <CreativeVideoPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Canvas',
      label: 'AI Video', labelKey: 'creativeVideoLabel',
      icon: WandIcon,
      hint: 'Generate avatar videos', hintKey: 'creativeVideoHint',
      order: 60,
      featureId: 'creative-video',
    },
  },
];

export const creativeVideoFeature: FrontendFeature = { id: 'creative-video', routes };
