import { lazy } from 'react';
import { DatabaseIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const KnowledgeBasePage = lazy(() => import('./KnowledgeBasePage.js').then((m) => ({ default: m.KnowledgeBasePage })));

const routes: FeatureRoute[] = [
  {
    // Moved out of the workspace rail into the admin "Access & data" group
    // (2026-06-17, user request) — it sits with Organizations / Keys / Example
    // data (org-scoped data stores). KB is now always-on (toggle removed; ADR
    // 0010/0024 graduation), so the nav entry is ungated.
    path: '/kb',
    element: <KnowledgeBasePage />,
    tier: 'admin',
    nav: {
      group: 'Access & data',
      label: 'Knowledge Base',
      icon: DatabaseIcon,
      hint: 'Document collections + semantic search (RAG)',
      
    },
  },
];

export const kbFeature: FrontendFeature = { id: 'kb', routes };
