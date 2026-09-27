import { lazy } from 'react';
import { LinkIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const SharingPage = lazy(() => import('./SharingPage.js').then((m) => ({ default: m.SharingPage })));

// ADR 0027 moved Sharing's nav into the admin-tier 'Content' group for cohesion
// with CMS / Media / Publishing. ADR 0434 graduated the `sharing` toggle to
// always-on (it is a host seam five features import), so the nav entry no longer
// carries a `featureId` — a graduated feature has no assignment, and
// `useFeatureVisible` would resolve a stale `featureId` to NOT-visible and hide
// the page outright.
const routes: FeatureRoute[] = [
  {
    path: '/sharing',
    element: <SharingPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Content',
      label: 'Sharing', labelKey: 'sharingLabel',
      icon: LinkIcon,
      hint: 'Public share links to pages + collections', hintKey: 'sharingHint',
      order: 40,
    },
  },
];

export const sharingFeature: FrontendFeature = { id: 'sharing', routes };
