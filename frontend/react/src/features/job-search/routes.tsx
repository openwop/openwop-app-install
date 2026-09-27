/**
 * Job-search frontend feature (ADR 0539/0541) — route + nav manifest.
 * The nav entry carries `featureId: 'job-search'`, so it hides unless the
 * toggle resolves enabled for the caller — which for a PRICED bundle is also
 * the entitlement gate.
 */
import { lazy } from 'react';
import { ShieldIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ApplyGrantPage = lazy(() => import('./ApplyGrantPage.js').then((m) => ({ default: m.ApplyGrantPage })));
const JobListingsPage = lazy(() => import('./JobListingsPage.js').then((m) => ({ default: m.JobListingsPage })));
const JobApplicationsPage = lazy(() => import('./JobApplicationsPage.js').then((m) => ({ default: m.JobApplicationsPage })));
const AnswerBankPage = lazy(() => import('./AnswerBankPage.js').then((m) => ({ default: m.AnswerBankPage })));
const ExceptionsPage = lazy(() => import('./ExceptionsPage.js').then((m) => ({ default: m.ExceptionsPage })));
const FunnelPage = lazy(() => import('./FunnelPage.js').then((m) => ({ default: m.FunnelPage })));

const routes: FeatureRoute[] = [
  {
    path: '/job-search/listings',
    element: <JobListingsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Access & data',
      label: 'Job listings', labelKey: 'listingsTitle',
      icon: ShieldIcon,
      hint: 'Postings found across your boards, deduped by content', hintKey: 'listingsLede',
      order: 61,
      featureId: 'job-search',
    },
  },
  {
    path: '/job-search/answers',
    element: <AnswerBankPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Access & data',
      label: 'Answer once', labelKey: 'bankTitle',
      icon: ShieldIcon,
      hint: 'Answer the questions applications ask, once', hintKey: 'bankLede',
      order: 59,
      featureId: 'job-search',
    },
  },
  {
    path: '/job-search/funnel',
    element: <FunnelPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Access & data',
      label: 'What is working', labelKey: 'funnelTitle',
      icon: ShieldIcon,
      hint: 'Response rates, follow-ups due, and drafts waiting', hintKey: 'funnelLede',
      order: 57,
      featureId: 'job-search',
    },
  },
  {
    path: '/job-search/exceptions',
    element: <ExceptionsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Access & data',
      label: 'Questions waiting', labelKey: 'excTitle',
      icon: ShieldIcon,
      hint: 'The whole interruption budget of a campaign, in one place', hintKey: 'excLede',
      order: 58,
      featureId: 'job-search',
    },
  },
  {
    path: '/job-search/applications',
    element: <JobApplicationsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Access & data',
      label: 'Applications', labelKey: 'appsTitle',
      icon: ShieldIcon,
      hint: 'Applications sent for you, and the verification links you have shared', hintKey: 'appsLede',
      order: 60,
      featureId: 'job-search',
    },
  },
  {
    path: '/job-search/authority',
    element: <ApplyGrantPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Access & data',
      label: 'Auto-apply authority', labelKey: 'title',
      icon: ShieldIcon,
      hint: 'Bounded, revocable consent for automatic job applications', hintKey: 'lede',
      order: 62,
      featureId: 'job-search',
    },
  },
];

export const jobSearchFeature: FrontendFeature = { id: 'job-search', routes };
