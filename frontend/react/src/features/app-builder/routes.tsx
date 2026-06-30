/**
 * App-builder editor frontend feature — route fragment (ADR 0153 Phase 2b / ADR 0001
 * §6). Appended to FRONTEND_FEATURES. The editor is reached by canvas id (or
 * `/app-builder/new?fromArtifact=…` from a chat artifact's "Open in editor"), so it has
 * no standalone nav entry — it opens from the canvas it edits.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AppBuilderEditorPage = lazy(() => import('./AppBuilderEditorPage.js').then((m) => ({ default: m.AppBuilderEditorPage })));

const routes: FeatureRoute[] = [
  {
    path: '/app-builder/:canvasId',
    element: <AppBuilderEditorPage />,
    tier: 'workspace',
  },
];

export const appBuilderFeature: FrontendFeature = { id: 'app-builder', routes };
