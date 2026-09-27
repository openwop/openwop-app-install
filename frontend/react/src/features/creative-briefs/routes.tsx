/**
 * Creative Briefs frontend feature (ADR 0353) — route fragment. Lazy page;
 * nav under Marketing beside the campaign surfaces.
 */
import { lazy } from 'react';
import { FileTextIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CreativeBriefsPage = lazy(() => import('./CreativeBriefsPage.js').then((m) => ({ default: m.CreativeBriefsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/creative-briefs',
    element: <CreativeBriefsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Creative Briefs', labelKey: 'creativeBriefsLabel',
      icon: FileTextIcon,
      order: 46,
      hint: 'Visual briefs for designers — scene, directions, mood board', hintKey: 'creativeBriefsHint',
      featureId: 'creative-briefs',
    },
  },
  // ADR 0522 — a brief opens at its OWN URL (§4.5 rule 12). The SAME component
  // serves both routes (the Tutorials precedent), so back-navigation keeps the
  // list's filters and view mode.
  { path: '/creative-briefs/:briefId', element: <CreativeBriefsPage />, tier: 'workspace', archetype: 'detail' },
];

export const creativeBriefsFeature: FrontendFeature = { id: 'creative-briefs', routes };
