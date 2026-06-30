/**
 * Navigation settings (ADR 0139) — the Menu-settings admin page. Lives in the
 * admin sidebar ("Platform" group). Always-on (no toggle): with empty config the
 * menu equals today's, so there's no risk surface to gate.
 */
import { lazy } from 'react';
import { SettingsIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const MenuSettingsPage = lazy(() => import('./MenuSettingsPage.js').then((m) => ({ default: m.MenuSettingsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/menu-settings',
    element: <MenuSettingsPage />,
    tier: 'admin',
    nav: { group: 'Platform', label: 'Menu settings', icon: SettingsIcon, hint: 'Customize what shows in each menu' },
  },
];

export const navigationSettingsFeature: FrontendFeature = { id: 'navigation-settings', routes };
