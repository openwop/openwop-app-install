/**
 * Models console (ADR 0145) — route + nav fragment, composed by the
 * `model-router` feature (ADR 0820 §8.3: the empty `models` feature package was
 * retired; the hub it shipped is model-router's console now).
 *
 * One admin destination (`/models`) consolidating the Routing + Leaderboard
 * surfaces into a tabbed console. The page PROJECTS its tabs from the FEATURES
 * manifest, so this module stays tiny: a lazy page + a single nav entry.
 *
 * ADR 0434 — the `models` toggle graduated to always-on: it only ever chose a
 * NAV SHAPE (hub vs two standalone entries), never a capability, so the console
 * is now the one shape. Its tabs' OWN toggles still gate them (`evals`).
 *
 * IMPORTANT: do NOT import `FEATURES` here — `routes.tsx` is evaluated while the
 * manifest is still being composed, so a static import would cycle. The page
 * reads the manifest at render time via its lazy import (see ModelsHubPage).
 */
import { lazy } from 'react';

// ADR 0378 P4 — the models walkthrough action pack, lazy chunk + boot-eager trigger.
void import('./walkthroughActions.js').then((m) => m.registerModelsWalkthroughActions());
import { ScaleIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';

const ModelsHubPage = lazy(() => import('./ModelsHubPage.js').then((m) => ({ default: m.ModelsHubPage })));

export const modelsHubRoutes: FeatureRoute[] = [
  {
    path: '/models',
    element: <ModelsHubPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'AI & automation',
      label: 'Models',
      labelKey: 'modelsLabel',
      icon: ScaleIcon,
      hint: 'Choose which model answers, and see which performs',
      hintKey: 'modelsHint',
      order: 5,
      activeFor: ['/model-router'],
    },
  },
];

