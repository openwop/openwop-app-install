import { lazy } from 'react';
import { ClipboardIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const FormsPage = lazy(() => import('./FormsPage.js').then((m) => ({ default: m.FormsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/forms',
    element: <FormsPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Forms',
      icon: ClipboardIcon,
      hint: 'Public forms → CRM contacts',
      featureId: 'forms',
    },
  },
];

export const formsFeature: FrontendFeature = { id: 'forms', routes };
