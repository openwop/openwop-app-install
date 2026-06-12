import { lazy } from 'react';
import { SendIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const EmailPage = lazy(() => import('./EmailPage.js').then((m) => ({ default: m.EmailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/email',
    element: <EmailPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Email',
      icon: SendIcon,
      hint: 'Templated campaigns over CRM contacts',
      featureId: 'email',
    },
  },
];

export const emailFeature: FrontendFeature = { id: 'email', routes };
