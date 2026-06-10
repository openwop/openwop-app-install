/**
 * CRM frontend feature — its route + nav manifest fragment (ADR 0001 §2.2/§4).
 * Registered into FRONTEND_FEATURES; chrome/features.tsx composes it into the
 * app's FEATURES. The nav entry carries `featureId: 'crm'` so the Sidebar hides
 * it unless the CRM toggle resolves enabled for the caller.
 */
import { lazy } from 'react';
import { BriefcaseIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CrmPage = lazy(() => import('./CrmPage.js').then((m) => ({ default: m.CrmPage })));

const routes: FeatureRoute[] = [
  {
    path: '/crm',
    element: <CrmPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'CRM',
      icon: BriefcaseIcon,
      hint: 'Contacts + triage',
      order: 40,
      featureId: 'crm',
    },
  },
];

export const crmFeature: FrontendFeature = { id: 'crm', routes };
