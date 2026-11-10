import { lazy } from 'react';
import type { FrontendFeature } from '../registry.js';
import { registerArtifactRenderer } from '../../chat/artifacts/rendererRegistry.js';
const Editor = lazy(() => import('./FilmEditorPage.js').then(m => ({ default: m.FilmEditorPage })));
const Presenter = lazy(() => import('./FilmPresentPage.js').then(m => ({ default: m.FilmPresentPage })));
const Audience = lazy(() => import('./FilmPresenter.js').then(m => ({ default: m.FilmAudience })));
registerArtifactRenderer({ artifactTypeId: 'canvas.film', editable: false, Component: lazy(() => import('./FilmEditorPage.js').then(m => ({ default: m.FilmPreview }))) });
export const filmsFeature: FrontendFeature = { id: 'films', routes: [
  { path: '/films/:canvasId', element: <Editor />, tier: 'workspace', archetype: 'canvas-editor', chrome: 'fullbleed' },
  { path: '/films/:canvasId/present', element: <Presenter />, tier: 'workspace', archetype: 'canvas-editor', chrome: 'fullbleed' },
  { path: '/films/audience', element: <Audience />, tier: 'workspace', archetype: 'canvas-editor', chrome: 'fullbleed' },
] };
