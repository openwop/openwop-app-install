/**
 * Manual-test runner frontend feature (ADR 0183) — route + nav (admin tier), moved out of the
 * core `chrome/features.tsx` manifest into a self-contained feature package wired via
 * `registry.ts`. ADR 0196 correction: originally shipped with NO toggle ("admin-tier gate +
 * authed, self-scoped backend routes"), which put a QA runner in every production deploy's
 * Platform nav. It is an engineering surface, so it now rides Gate B: `nav.featureId`
 * hides the nav entry and the page renders a not-enabled StateCard unless the
 * `developer-tools` toggle resolves enabled.
 */
import { lazy } from 'react';
import { ClipboardIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ManualTestsPage = lazy(() => import('./ManualTestsPage.js').then((m) => ({ default: m.ManualTestsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/test',
    element: <ManualTestsPage />,
    tier: 'admin', archetype: 'admin',
    chrome: 'narrow',
    nav: { group: 'Developer', label: 'Manual tests', labelKey: 'manualTestsLabel', icon: ClipboardIcon, hint: 'Human-run feature tests', hintKey: 'manualTestsHint', order: 95, featureId: 'developer-tools' },
  },
];

export const manualTestsFeature: FrontendFeature = { id: 'manual-tests', routes };
