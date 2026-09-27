/**
 * App-builder editor frontend feature — route fragment (ADR 0153 Phase 2b / ADR 0001
 * §6). Appended to FRONTEND_FEATURES. `/app-builder` is the focused creation
 * entry; existing canvases remain in the unified Documents inventory, while an
 * editor still opens by canvas id (or `/app-builder/new?fromArtifact=…`).
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AppBuilderEditorPage = lazy(() => import('./AppBuilderEditorPage.js').then((m) => ({ default: m.AppBuilderEditorPage })));
const AppBuilderPreviewPage = lazy(() => import('./AppBuilderPreviewPage.js').then((m) => ({ default: m.AppBuilderPreviewPage })));
const AppBuilderHubPage = lazy(() => import('./AppBuilderHubPage.js').then((m) => ({ default: m.AppBuilderHubPage })));

const routes: FeatureRoute[] = [
  {
    path: '/app-builder',
    element: <AppBuilderHubPage />,
    tier: 'workspace', archetype: 'hub',
  },
  {
    path: '/app-builder/:canvasId',
    element: <AppBuilderEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
  // ADR 0305 Phase D — the interactive device-framed walkthrough.
  {
    path: '/app-builder/:canvasId/preview',
    element: <AppBuilderPreviewPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
];

export const appBuilderFeature: FrontendFeature = { id: 'app-builder', routes };
