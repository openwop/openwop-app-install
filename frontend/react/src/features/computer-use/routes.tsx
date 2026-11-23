/**
 * Computer-use frontend feature (ADR 1136 P3b) — route + nav manifest. The nav
 * entry carries `featureId: 'computer-use'`, so it hides unless the toggle
 * resolves enabled for the caller (default off until P6).
 */
import { lazy } from 'react';
import { GlobeIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ComputerUseSessionsPage = lazy(() => import('./ComputerUseSessionsPage.js').then((m) => ({ default: m.ComputerUseSessionsPage })));
const ComputerUseSessionPage = lazy(() => import('./ComputerUseSessionPage.js').then((m) => ({ default: m.ComputerUseSessionPage })));

const routes: FeatureRoute[] = [
  {
    path: '/computer-use',
    element: <ComputerUseSessionsPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      labelKey: 'computerUseLabel',
      icon: GlobeIcon,
      hintKey: 'computerUseHint',
      order: 65,
      featureId: 'computer-use',
    },
  },
  {
    path: '/computer-use/sessions/:sessionId',
    element: <ComputerUseSessionPage />,
    tier: 'workspace', archetype: 'detail',
  },
];

export const computerUseFeature: FrontendFeature = { id: 'computer-use', routes };
