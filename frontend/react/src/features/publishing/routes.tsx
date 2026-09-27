import { lazy } from 'react';

// P4 continuation — this page's walkthrough spotlight (lazy chunk, boot-eager trigger).
void import('../../walkthroughs/pageSpotlight.js').then((m) => m.registerPageSpotlight('publishing.page.view', '/publishing', 'publishing.page'));
import { GlobeIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PublishingPage = lazy(() => import('./PublishingPage.js').then((m) => ({ default: m.PublishingPage })));

// ADR 0027: Publishing is always-on (no `featureId`) and lives in the admin-tier
// 'Content' group.
const routes: FeatureRoute[] = [
  {
    path: '/publishing',
    element: <PublishingPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Content',
      label: 'Publishing', labelKey: 'publishingLabel',
      icon: GlobeIcon,
      hint: 'Public site + SEO for CMS pages', hintKey: 'publishingHint',
      order: 30,
    },
  },
];

export const publishingFeature: FrontendFeature = { id: 'publishing', routes };
