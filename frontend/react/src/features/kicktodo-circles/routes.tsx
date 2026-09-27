/**
 * KickTodo Circles frontend feature (ADR 0419 P5) — route + nav manifest,
 * gated on the kicktodo-accountability toggle.
 */
import { lazy } from 'react';
import { UserIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CirclesPage = lazy(() => import('./CirclesPage.js').then((m) => ({ default: m.CirclesPage })));
const CoachConsolePage = lazy(() => import('./CoachConsolePage.js').then((m) => ({ default: m.CoachConsolePage })));

const routes: FeatureRoute[] = [
  {
    path: '/circles',
    element: <CirclesPage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Circles', labelKey: 'navLabel',
      icon: UserIcon,
      hint: 'Accountability circles & coaches', hintKey: 'navHint',
      order: 30,
      featureId: 'kicktodo-accountability',
    },
  },
  // ADR 0501 (console) — the coach's desk: caseload + proposal composer. Reached
  // from Circles; no nav item (most participants never coach).
  {
    path: '/circles/coach',
    element: <CoachConsolePage />,
    tier: 'site', archetype: 'standard-index',
  },
];

export const kicktodoCirclesFeature: FrontendFeature = { id: 'kicktodo-accountability', routes };
