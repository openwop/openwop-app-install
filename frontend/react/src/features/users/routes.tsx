/**
 * Users frontend feature — its route + nav manifest fragment (ADR 0002).
 * Registered into FRONTEND_FEATURES; chrome/features.tsx composes it into the
 * app's FEATURES. The nav entry carries `featureId: 'users'` so the Sidebar
 * hides it unless the Users toggle resolves enabled for the caller.
 */
import { lazy } from 'react';
import { UserIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const UsersPage = lazy(() => import('./UsersPage.js').then((m) => ({ default: m.UsersPage })));

const routes: FeatureRoute[] = [
  {
    path: '/users',
    element: <UsersPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Users',
      icon: UserIcon,
      hint: 'Accounts + identity',
      featureId: 'users',
    },
  },
];

export const usersFeature: FrontendFeature = { id: 'users', routes };
