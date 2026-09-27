/**
 * Drawings editor frontend feature — route fragment (ADR 0310 Phase C / ADR
 * 0001 §6). Deep-link only, from the drawing chat card's "Open in editor".
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DrawingsEditorPage = lazy(() => import('./DrawingsEditorPage.js').then((m) => ({ default: m.DrawingsEditorPage })));

const routes: FeatureRoute[] = [
  {
    path: '/drawings/:canvasId',
    element: <DrawingsEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
];

export const drawingsFeature: FrontendFeature = { id: 'drawings', routes };
