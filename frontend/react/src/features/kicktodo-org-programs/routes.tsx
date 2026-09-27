/**
 * kicktodo-organizations frontend manifest (ADR 0428 P4): the org-programs
 * admin page in the KickTodo nav group, gated on the toggle.
 */
import { lazy } from 'react';
import { BuildingIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const OrgProgramsPage = lazy(() => import('./OrgProgramsPage.js').then((m) => ({ default: m.OrgProgramsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/kicktodo/org-programs',
    element: <OrgProgramsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Org programs', labelKey: 'navLabel',
      icon: BuildingIcon,
      hint: 'Org challenge libraries and reports', hintKey: 'navHint',
      order: 60,
      featureId: 'kicktodo-organizations',
    },
  },
];

export const kicktodoOrgProgramsFeature: FrontendFeature = { id: 'kicktodo-organizations', routes };
