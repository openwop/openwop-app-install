import { lazy } from 'react';
import { GlobeIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PublishingPage = lazy(() => import('./PublishingPage.js').then((m) => ({ default: m.PublishingPage })));

const routes: FeatureRoute[] = [
  {
    path: '/publishing',
    element: <PublishingPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Publishing',
      icon: GlobeIcon,
      hint: 'Public site + SEO for CMS pages',
      featureId: 'publishing',
    },
  },
];

export const publishingFeature: FrontendFeature = { id: 'publishing', routes };
