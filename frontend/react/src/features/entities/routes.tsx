/** Entities feature routes (ADR 0386 Phase 1). */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';
import { DatabaseIcon } from '../../ui/icons/index.js';

const EntitiesPage = lazy(() => import('./EntitiesPage.js').then((m) => ({ default: m.EntitiesPage })));
const SchemaGraphPage = lazy(() => import('./SchemaGraphPage.js').then((m) => ({ default: m.SchemaGraphPage })));

const routes: FeatureRoute[] = [
  {
    // ER schema graph (Phase 5) — linked from the Entities page, no own nav entry.
    path: '/entities/schema',
    element: <SchemaGraphPage />,
    tier: 'workspace', archetype: 'standard-index',
  },
  {
    path: '/entities',
    element: <EntitiesPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Platform',
      label: 'Entities',
      labelKey: 'entitiesLabel',
      icon: DatabaseIcon,
      hint: 'User-defined content types',
      hintKey: 'entitiesHint',
      featureId: 'entities',
    },
  },
];

export const entitiesFeature: FrontendFeature = { id: 'entities', routes };
