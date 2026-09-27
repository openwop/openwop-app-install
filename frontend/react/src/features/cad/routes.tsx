/**
 * CAD editor frontend feature — route fragment (ADR 0310 Phase C / ADR 0001
 * §6). Deep-link only, from the CAD chat card's "Open in editor".
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CadEditorPage = lazy(() => import('./CadEditorPage.js').then((m) => ({ default: m.CadEditorPage })));

const routes: FeatureRoute[] = [
  {
    path: '/cad/:canvasId',
    element: <CadEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
];

export const cadFeature: FrontendFeature = { id: 'cad', routes };
