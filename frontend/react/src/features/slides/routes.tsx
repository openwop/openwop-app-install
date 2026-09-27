/**
 * Slides editor frontend feature — route fragment (ADR 0310 Phase B / ADR 0001
 * §6). Appended to FRONTEND_FEATURES. The editor is reached by canvas id (or
 * `/slides/new?fromArtifact=…` from a slides chat card's "Open in editor"), so
 * it has no standalone nav entry — it opens from the deck it edits.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SlidesEditorPage = lazy(() => import('./SlidesEditorPage.js').then((m) => ({ default: m.SlidesEditorPage })));
const SlidesPreviewPage = lazy(() => import('./SlidesPreviewPage.js').then((m) => ({ default: m.SlidesPreviewPage })));
const SlidesPresentPage = lazy(() => import('./SlidesPresentPage.js').then((m) => ({ default: m.SlidesPresentPage })));

const routes: FeatureRoute[] = [
  {
    path: '/slides/:canvasId',
    element: <SlidesEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
  {
    path: '/slides/:canvasId/preview',
    element: <SlidesPreviewPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
  {
    path: '/slides/:canvasId/present',
    element: <SlidesPresentPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // ADR 0328 P4 — the present stage: full-bleed like the editor/preview.
    chrome: 'fullbleed',
  },
];

export const slidesFeature: FrontendFeature = { id: 'slides', routes };
