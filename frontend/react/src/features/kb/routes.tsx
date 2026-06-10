import { lazy } from 'react';
import { DatabaseIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const KnowledgeBasePage = lazy(() => import('./KnowledgeBasePage.js').then((m) => ({ default: m.KnowledgeBasePage })));

const routes: FeatureRoute[] = [
  {
    path: '/kb',
    element: <KnowledgeBasePage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Knowledge Base',
      icon: DatabaseIcon,
      hint: 'Document collections + semantic search (RAG)',
      featureId: 'kb',
    },
  },
];

export const kbFeature: FrontendFeature = { id: 'kb', routes };
