/**
 * Campaign Studio editor frontend feature — route fragment (ADR 0310 Phase C /
 * ADR 0001 §6). Deep-link only, from the campaign chat card's "Open in editor".
 * The `campaign-studio` id is the ADR 0153 canvas — distinct from the
 * Marketing `campaigns` console feature.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignStudioEditorPage = lazy(() => import('./CampaignStudioEditorPage.js').then((m) => ({ default: m.CampaignStudioEditorPage })));
const PlanRedirect = lazy(() => import('./PlanRedirect.js').then((m) => ({ default: m.PlanRedirect })));

const routes: FeatureRoute[] = [
  {
    // ADR 0941 D5 — plans (the canvas editor) live two segments deep.
    path: '/campaign-studio/plans/:canvasId',
    element: <CampaignStudioEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    // Full-screen editor surface — height-locked, no dot-grid, no 1200px cap
    // (the builder precedent; grade pass UX-CV-2).
    chrome: 'fullbleed',
  },
  {
    // The pre-0941 plan URL: a redirect that accepts only canvas-id shapes and `new`.
    path: '/campaign-studio/:canvasId',
    element: <PlanRedirect />,
    tier: 'workspace', archetype: 'canvas-editor',
    chrome: 'fullbleed',
  },
];

export const campaignStudioFeature: FrontendFeature = { id: 'campaign-studio', routes };
