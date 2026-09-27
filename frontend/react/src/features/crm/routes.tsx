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
const CompanyDetailPage = lazy(() => import('./CompanyDetailPage.js').then((m) => ({ default: m.CompanyDetailPage })));
const DealDetailPage = lazy(() => import('./DealDetailPage.js').then((m) => ({ default: m.DealDetailPage })));
const PipelinesPage = lazy(() => import('./PipelinesPage.js').then((m) => ({ default: m.PipelinesPage })));
const ContactFieldsPage = lazy(() => import('./ContactFieldsPage.js').then((m) => ({ default: m.ContactFieldsPage })));

const routes: FeatureRoute[] = [
  // Record detail pages (gap-analysis §5 B1) — org context rides ?org=.
  { path: '/crm/companies/:companyId', element: <CompanyDetailPage />, tier: 'workspace' , archetype: 'detail',},
  { path: '/crm/deals/:dealId', element: <DealDetailPage />, tier: 'workspace' , archetype: 'detail',},
  // Configuration surfaces (CRM-UX-2 / CRM-UX-7) — deliberately routes rather
  // than tabs 9 and 10: CRM already ships the app's widest tablist (CRM-UX-5),
  // and these are occasional administrative acts, not collections you browse.
  // The Deals tab links to pipelines (org rides ?org=); the Contacts tab links
  // to contact fields (tenant-scoped, so it takes no org).
  { path: '/crm/pipelines', element: <PipelinesPage />, tier: 'workspace', archetype: 'detail' },
  { path: '/crm/fields', element: <ContactFieldsPage />, tier: 'workspace', archetype: 'detail' },
  {
    path: '/crm',
    element: <CrmPage />,
    tier: 'workspace', archetype: 'data-dense-index',
    nav: {
      group: 'CRM',
      label: 'CRM', labelKey: 'crmLabel',
      icon: BriefcaseIcon,
      hint: 'Contacts + triage', hintKey: 'crmHint',
      order: 40,
      featureId: 'crm',
    },
  },
];

export const crmFeature: FrontendFeature = { id: 'crm', routes };
