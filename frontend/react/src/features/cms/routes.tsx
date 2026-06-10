import { lazy } from 'react';
import { FileTextIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CmsPage = lazy(() => import('./CmsPage.js').then((m) => ({ default: m.CmsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/cms',
    element: <CmsPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'CMS',
      icon: FileTextIcon,
      hint: 'Pages + page builder',
      order: 50,
      featureId: 'cms',
    },
  },
];

export const cmsFeature: FrontendFeature = { id: 'cms', routes };
