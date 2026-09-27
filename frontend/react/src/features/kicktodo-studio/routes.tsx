/**
 * Creator Studio frontend manifest (ADR 0415 D5 / KTC-3): rides the EXISTING
 * `kicktodo-creator` toggle — no new feature id, no new toggle.
 */
import { lazy } from 'react';
import { WandIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const StudioPage = lazy(() => import('./StudioPage.js').then((m) => ({ default: m.StudioPage })));
const CandidateWorkspacePage = lazy(() =>
  import('./CandidateWorkspacePage.js').then((m) => ({ default: m.CandidateWorkspacePage })));
const CreatorInsightsPage = lazy(() =>
  import('./CreatorInsightsPage.js').then((m) => ({ default: m.CreatorInsightsPage })));
// ADR 0458 §2.3 — the challenge-outline canvas editor. Lazy so the whole canvas
// chassis stays out of the eager route graph. Rides the kicktodo-creator toggle
// (this FrontendFeature's id); created per-candidate, never from the gallery.
const ChallengeOutlineEditorPage = lazy(() =>
  import('../challenge-outline/ChallengeOutlineEditorPage.js').then((m) => ({ default: m.ChallengeOutlineEditorPage })));

const routes: FeatureRoute[] = [
  {
    path: '/kicktodo/studio',
    element: <StudioPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Studio', labelKey: 'navLabel',
      icon: WandIcon,
      hint: 'Challenge Factory operator surface', hintKey: 'navHint',
      order: 70,
      featureId: 'kicktodo-creator',
    },
  },
  {
    // ADR 0437 UX-2.2 — candidate workspace (detail; reached from a Studio row, no nav entry).
    path: '/kicktodo/studio/candidates/:candidateId',
    element: <CandidateWorkspacePage />,
    tier: 'workspace', archetype: 'detail',
  },
  {
    // ADR 0437 UX-2.7 — creator insights & earnings (reached from the Studio, no nav entry).
    path: '/kicktodo/studio/insights',
    element: <CreatorInsightsPage />,
    tier: 'workspace', archetype: 'standard-index',
  },
  {
    // ADR 0458 §2.3 — the challenge-outline canvas editor (reached from a
    // candidate workspace's "Open outline", no nav entry). Full-bleed like every
    // canvas editor surface.
    path: '/challenge-outline/:canvasId',
    element: <ChallengeOutlineEditorPage />,
    tier: 'workspace', archetype: 'canvas-editor',
    chrome: 'fullbleed',
  },
];

export const kicktodoStudioFeature: FrontendFeature = { id: 'kicktodo-creator', routes };
