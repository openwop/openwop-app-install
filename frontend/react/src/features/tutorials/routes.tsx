/**
 * Tutorials frontend feature (ADR 0490) — route + nav fragment. Always-on
 * (docs/IA surface, the access-hub precedent — no toggleDefault): tutorials
 * teach features the workspace may not have enabled yet, so the reader itself
 * is never gated. Lives on the ADMIN tier (Platform group) per product ruling
 * 2026-07-06 — walkthroughs sit with the console/documentation surfaces, not
 * the day-to-day workspace rail.
 */
import { lazy } from 'react';
import { BookOpenIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const TutorialsPage = lazy(() => import('./TutorialsPage.js').then((m) => ({ default: m.TutorialsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/tutorials',
    element: <TutorialsPage />,
    tier: 'admin', archetype: 'admin',
    nav: { group: 'Learning & support', label: 'Tutorials', labelKey: 'tutorialsLabel', icon: BookOpenIcon, hint: 'Hands-on product walkthroughs', hintKey: 'tutorialsHint', order: 88 },
  },
  {
    path: '/tutorials/:tutorialId',
    element: <TutorialsPage />,
    tier: 'admin', archetype: 'admin',
  },
];

export const tutorialsFeature: FrontendFeature = { id: 'tutorials', routes };
