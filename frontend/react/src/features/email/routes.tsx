import { lazy } from 'react';
import { SendIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const EmailPage = lazy(() => import('./EmailPage.js').then((m) => ({ default: m.EmailPage })));
const EmailTemplateDetailPage = lazy(() => import('./EmailTemplateDetailPage.js').then((m) => ({ default: m.EmailTemplateDetailPage })));

const routes: FeatureRoute[] = [
  {
    path: '/email',
    element: <EmailPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'CRM',
      label: 'Email', labelKey: 'emailLabel',
      icon: SendIcon,
      hint: 'Templated campaigns over CRM contacts', hintKey: 'emailHint',
      featureId: 'email',
    },
  },
  // ADR 0520 — the template editor lives at the template's OWN URL (§4.5 rule
  // 12), not inline in the hub's list card behind a `?template=` mirror. No
  // `nav` entry: a detail route is reached from its collection.
  { path: '/email/templates/:templateId', element: <EmailTemplateDetailPage />, tier: 'workspace', archetype: 'detail' },
];

export const emailFeature: FrontendFeature = { id: 'email', routes };
