import { lazy } from 'react';
import { BuildingIcon, UserIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ProfilePage = lazy(() => import('./ProfilePage.js').then((m) => ({ default: m.ProfilePage })));
const TeamPage = lazy(() => import('./TeamPage.js').then((m) => ({ default: m.TeamPage })));

const routes: FeatureRoute[] = [
  {
    path: '/profile',
    element: <ProfilePage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'My Profile',
      icon: UserIcon,
      hint: 'Your self-service profile',
      featureId: 'profiles',
    },
  },
  {
    path: '/team',
    element: <TeamPage />,
    tier: 'workspace',
    nav: {
      group: 'Workspace',
      label: 'Team',
      icon: BuildingIcon,
      hint: 'Team directory + endorsements',
      featureId: 'profiles',
    },
  },
];

export const profilesFeature: FrontendFeature = { id: 'profiles', routes };
