/**
 * Models console (ADR 0145) — route + nav fragment.
 *
 * One admin destination (`/models`) consolidating the Routing + Leaderboard
 * surfaces into a tabbed console. The page PROJECTS its tabs from the FEATURES
 * manifest, so this module stays tiny: a lazy page + a single nav entry, gated on
 * the `models` toggle (default OFF, bucket `tenant`).
 *
 * IMPORTANT: do NOT import `FEATURES` here — `routes.tsx` is evaluated while the
 * manifest is still being composed, so a static import would cycle. The page
 * reads the manifest at render time via its lazy import (see ModelsHubPage).
 */
import { lazy } from 'react';
import { ScaleIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ModelsHubPage = lazy(() => import('./ModelsHubPage.js').then((m) => ({ default: m.ModelsHubPage })));

const routes: FeatureRoute[] = [
  {
    path: '/models',
    element: <ModelsHubPage />,
    tier: 'admin',
    nav: {
      group: 'Platform',
      label: 'Models',
      labelKey: 'modelsLabel',
      icon: ScaleIcon,
      hint: 'Choose which model answers, and see which performs',
      hintKey: 'modelsHint',
      order: 5,
      featureId: 'models',
    },
  },
];

export const modelsFeature: FrontendFeature = { id: 'models', routes };
