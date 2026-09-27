import { lazy } from 'react';
import { ClipboardIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const FormsPage = lazy(() => import('./FormsPage.js').then((m) => ({ default: m.FormsPage })));
const FormDetailPage = lazy(() => import('./FormDetailPage.js').then((m) => ({ default: m.FormDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/forms',
    element: <FormsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      // ADR 0330 — forms is the standalone capture primitive; it sits with the
      // authoring cluster (Workflows/Documents/Comments) in the Workspace section,
      // not under CRM.
      group: 'Workspace',
      label: 'Forms', labelKey: 'formsLabel',
      icon: ClipboardIcon,
      order: 20,
      hint: 'Form builder + submissions', hintKey: 'formsHint',
      featureId: 'forms',
    },
  },
  // ADR 0519 — the builder lives at the form's OWN URL (§4.5 rule 12), not
  // stacked under the collection behind a `?form=` mirror. No `nav` entry: a
  // detail route is reached from its collection, never from the rail.
  { path: '/forms/:formId', element: <FormDetailPage />, tier: 'workspace', archetype: 'detail' },
];

export const formsFeature: FrontendFeature = { id: 'forms', routes };
