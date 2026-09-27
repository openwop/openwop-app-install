import { lazy } from 'react';
import { FileTextIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const DocumentsPage = lazy(() => import('./DocumentsPage.js').then((m) => ({ default: m.DocumentsPage })));
// ADR 0350 Phase 1 — every markdown document gets its own full-screen URL.
const DocumentDetailPage = lazy(() => import('./DocumentDetailPage.js').then((m) => ({ default: m.DocumentDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/documents',
    element: <DocumentsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      label: 'Documents', labelKey: 'documentsLabel',
      icon: FileTextIcon,
      order: 30,
      hint: 'Business documents + templates (SOW, PRD, RFP, agendas)', hintKey: 'documentsHint',
      featureId: 'documents',
    },
  },
  {
    // Per-document URL (ADR 0350 Phase 1) — shareable, middle-clickable, and its
    // own full-screen surface (not a panel under the list). Org rides as `?org=`.
    path: '/documents/:documentId',
    element: <DocumentDetailPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    chrome: 'fullbleed',
  },
];

export const documentsFeature: FrontendFeature = { id: 'documents', routes };
