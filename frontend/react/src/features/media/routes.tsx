import { lazy } from 'react';
import { ImageIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MediaLibraryPage = lazy(() => import('./MediaLibraryPage.js').then((m) => ({ default: m.MediaLibraryPage })));

const routes: FeatureRoute[] = [
  {
    path: '/media',
    element: <MediaLibraryPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Media',
      icon: ImageIcon,
      hint: 'Org asset library',
      featureId: 'media',
    },
  },
];

export const mediaFeature: FrontendFeature = { id: 'media', routes };
