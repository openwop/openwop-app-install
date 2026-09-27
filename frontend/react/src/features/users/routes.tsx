/**
 * Users frontend feature — its route + nav manifest fragment (ADR 0002).
 * Registered into FRONTEND_FEATURES. Users & Authentication graduated off its
 * feature toggle on 2026-06-11 (feature.ts § Correction): identity is platform
 * plumbing, so the nav is `tier: 'admin'` (renders in the AdminLayout rail's
 * "Access & data" group, alongside Connections) and carries no `featureId` gate.
 */
import { lazy } from 'react';

// P4 continuation — this page's walkthrough spotlight (lazy chunk, boot-eager trigger).
void import('../../walkthroughs/pageSpotlight.js').then((m) => m.registerPageSpotlight('users.page.view', '/users', 'users.page'));
import { UserIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const UsersPage = lazy(() => import('./UsersPage.js').then((m) => ({ default: m.UsersPage })));

const routes: FeatureRoute[] = [
  {
    path: '/users',
    element: <UsersPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Access & data',
      label: 'Users', labelKey: 'usersLabel',
      icon: UserIcon,
      hint: 'Accounts + identity', hintKey: 'usersHint',
    },
    // ADR 0144 §correction — Users/People is account & identity management, a
    // standalone admin surface, NOT a credential tab in the Access Hub. It keeps
    // its own `/users` nav entry (no `hubTab`, no `hiddenWhenFeature`).
  },
];

export const usersFeature: FrontendFeature = { id: 'users', routes };
