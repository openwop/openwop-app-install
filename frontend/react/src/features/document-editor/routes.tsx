/**
 * Rich-text document editor frontend feature — route fragment (ADR 0334 Phase 1
 * / ADR 0001 §6). The page (and therefore TipTap) is lazy so the editor engine
 * never enters the entry bundle.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DocumentEditorPage = lazy(() => import('./DocumentEditorPage.js').then((m) => ({ default: m.DocumentEditorPage })));

const routes: FeatureRoute[] = [
  {
    path: '/document-editor/:canvasId',
    element: <DocumentEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — the canvas-editor chrome convention.
    chrome: 'fullbleed',
  },
];

export const documentEditorFeature: FrontendFeature = { id: 'document-editor', routes };
