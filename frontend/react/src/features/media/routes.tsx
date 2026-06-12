import { lazy } from 'react';
import { ImageIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MediaLibraryPage = lazy(() => import('./MediaLibraryPage.js').then((m) => ({ default: m.MediaLibraryPage })));

// ADR 0027: Media is always-on (no `featureId`) and lives in the admin-tier
// 'Content' group alongside CMS / Publishing.
const routes: FeatureRoute[] = [
  {
    path: '/media',
    element: <MediaLibraryPage />,
    tier: 'admin',
    nav: {
      group: 'Content',
      label: 'Media',
      icon: ImageIcon,
      hint: 'Org asset library',
      order: 10,
    },
  },
];

export const mediaFeature: FrontendFeature = { id: 'media', routes };
