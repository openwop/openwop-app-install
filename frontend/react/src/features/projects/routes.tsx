/**
 * Projects frontend routes (ADR 0046). A workspace-tier list page + a detail page
 * (board + memory tabs). Always-on (§ Correction 2026-06-15 — graduated off the
 * `projects` toggle): the nav has no `featureId`, so it always shows; access stays
 * org-scoped on the backend (a user with no org sees an empty list).
 */
import { lazy } from 'react';

// P4 continuation — this page's walkthrough spotlight (lazy chunk, boot-eager trigger).
void import('../../walkthroughs/pageSpotlight.js').then((m) => m.registerPageSpotlight('projects.page.view', '/projects', 'projects.page'));
import { FolderIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ProjectsPage = lazy(() => import('./ProjectsPage.js').then((m) => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazy(() => import('./ProjectDetailPage.js').then((m) => ({ default: m.ProjectDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/projects',
    element: <ProjectsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Planning',
      label: 'Projects', labelKey: 'projectsLabel',
      icon: FolderIcon,
      order: 38,
      hint: 'Work containers — board, memory, workflows', hintKey: 'projectsHint',
    },
  },
  { path: '/projects/:projectId', element: <ProjectDetailPage />, tier: 'workspace' , archetype: 'detail',},
];

export const projectsFeature: FrontendFeature = { id: 'projects', routes };
