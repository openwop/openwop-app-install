import { lazy } from 'react';
import { LinkIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SharingPage = lazy(() => import('./SharingPage.js').then((m) => ({ default: m.SharingPage })));

const routes: FeatureRoute[] = [
  {
    path: '/sharing',
    element: <SharingPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Sharing',
      icon: LinkIcon,
      hint: 'Public share links to pages + collections',
      featureId: 'sharing',
    },
  },
];

export const sharingFeature: FrontendFeature = { id: 'sharing', routes };
