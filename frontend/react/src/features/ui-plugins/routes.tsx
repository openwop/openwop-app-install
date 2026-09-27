import { lazy } from 'react';
import { PlugIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const UiPluginsPage = lazy(() => import('./UiPluginsPage.js').then((m) => ({ default: m.UiPluginsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/ui-plugins',
    element: <UiPluginsPage />,
    // Admin tier (product ruling 2026-07-06): an extensibility/operator surface,
    // and 'Developer' was already ordered as an admin-tier group in GROUP_ORDER.
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Developer',
      label: 'UI Plugins', labelKey: 'uiPluginsLabel',
      icon: PlugIcon,
      hint: 'Sandboxed front-end plugin packs (RFC 0117/0119)', hintKey: 'uiPluginsHint',
      featureId: 'ui-plugins',
    },
  },
];

export const uiPluginsFeature: FrontendFeature = { id: 'ui-plugins', routes };
