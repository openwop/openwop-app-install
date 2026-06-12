import { lazy } from 'react';
import { FileTextIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CmsPage = lazy(() => import('./CmsPage.js').then((m) => ({ default: m.CmsPage })));

// ADR 0027: CMS is always-on (no `featureId`) and lives in the admin-tier
// 'Content' group (back-office content tooling), not the main workspace rail.
const routes: FeatureRoute[] = [
  {
    path: '/cms',
    element: <CmsPage />,
    tier: 'admin',
    nav: {
      group: 'Content',
      label: 'CMS',
      icon: FileTextIcon,
      hint: 'Pages + page builder',
      order: 20,
    },
  },
];

export const cmsFeature: FrontendFeature = { id: 'cms', routes };
