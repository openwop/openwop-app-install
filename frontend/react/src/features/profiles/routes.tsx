import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ProfilePage = lazy(() => import('./ProfilePage.js').then((m) => ({ default: m.ProfilePage })));
const TeamPage = lazy(() => import('./TeamPage.js').then((m) => ({ default: m.TeamPage })));

// 'My Profile' + 'Team' deliberately carry NO `nav` entry: they surface in the
// account (profile) popover menu in SignInButton, not the primary sidebar rail.
const routes: FeatureRoute[] = [
  {
    path: '/profile',
    element: <ProfilePage />,
    tier: 'workspace',
  },
  {
    path: '/team',
    element: <TeamPage />,
    tier: 'workspace',
  },
];

export const profilesFeature: FrontendFeature = { id: 'profiles', routes };
