/**
 * Research Notebooks frontend feature — route + nav fragment (ADR 0084 / ADR
 * 0001 §6). Appended to FRONTEND_FEATURES; nav gated by `featureId: 'notebooks'`.
 */
import { lazy } from 'react';
import { BookOpenIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const NotebooksPage = lazy(() => import('./NotebooksPage.js').then((m) => ({ default: m.NotebooksPage })));

const routes: FeatureRoute[] = [
  {
    path: '/notebooks',
    element: <NotebooksPage />,
    tier: 'workspace',
    nav: { group: 'Workspace', label: 'Notebooks', icon: BookOpenIcon, hint: 'Research notebooks — sources, notes, grounded ask', featureId: 'notebooks' },
  },
];

export const notebooksFeature: FrontendFeature = { id: 'notebooks', routes };
