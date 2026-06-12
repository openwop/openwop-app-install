import { lazy } from 'react';
import { LinkIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SharingPage = lazy(() => import('./SharingPage.js').then((m) => ({ default: m.SharingPage })));

// ADR 0027: Sharing's nav moves into the admin-tier 'Content' group for cohesion
// with CMS / Media / Publishing, but it STAYS toggle-gated (`featureId: 'sharing'`,
// composes KB — out of scope to make always-on). This proves `nav.group` is
// independent of toggle state: a toggle-gated item can sit in an always-on group
// and still hide when its toggle is off.
const routes: FeatureRoute[] = [
  {
    path: '/sharing',
    element: <SharingPage />,
    tier: 'admin',
    nav: {
      group: 'Content',
      label: 'Sharing',
      icon: LinkIcon,
      hint: 'Public share links to pages + collections',
      order: 40,
      featureId: 'sharing',
    },
  },
];

export const sharingFeature: FrontendFeature = { id: 'sharing', routes };
