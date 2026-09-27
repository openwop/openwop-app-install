/**
 * Canvas packs frontend feature — route fragment (ADR 0310 Phase D / ADR 0001
 * §6). ONE generic route serves every pack-declared canvas type; there is no
 * per-type frontend code by design. Deep-link only.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PackCanvasEditorPage = lazy(() => import('./PackCanvasEditorPage.js').then((m) => ({ default: m.PackCanvasEditorPage })));

const routes: FeatureRoute[] = [
  {
    path: '/canvas/:typeId/:canvasId',
    element: <PackCanvasEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
];

export const canvasPacksFeature: FrontendFeature = { id: 'canvas-packs', routes };
