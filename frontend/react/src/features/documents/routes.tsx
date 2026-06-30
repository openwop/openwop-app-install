import { lazy } from 'react';
import { FileTextIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DocumentsPage = lazy(() => import('./DocumentsPage.js').then((m) => ({ default: m.DocumentsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/documents',
    element: <DocumentsPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Documents',
      icon: FileTextIcon,
      hint: 'Business documents + templates (SOW, PRD, RFP, agendas)',
      featureId: 'documents',
    },
  },
];

export const documentsFeature: FrontendFeature = { id: 'documents', routes };
