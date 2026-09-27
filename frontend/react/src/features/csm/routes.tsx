/**
 * CSM frontend feature — route + nav fragment (ADR 0001 §6). Appended to
 * FRONTEND_FEATURES; nav gated by `featureId: 'csm'`.
 */
import { lazy } from 'react';
import { BotIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CsmPage = lazy(() => import('./CsmPage.js').then((m) => ({ default: m.CsmPage })));

const routes: FeatureRoute[] = [
  {
    path: '/csm',
    element: <CsmPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'CRM', label: 'CSM', labelKey: 'csmLabel', icon: BotIcon, hint: 'Customer-success accounts', hintKey: 'csmHint', featureId: 'csm' },
  },
];

export const csmFeature: FrontendFeature = { id: 'csm', routes };
