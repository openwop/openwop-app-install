/**
 * ADR 0958 P2 — the collaborator's pages: "Shared with me", one granted resource,
 * and accepting an invite. Signed-in, no app nav (ADR 0958 matrix row 10: no nav
 * and no chat for collaborators; the invite link lands here). Not gated on any
 * toggle of the collaborator's OWN workspace: what they may see is decided by the
 * agency's grant, server-side.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CollabHomePage = lazy(() => import('./CollabPages.js').then((m) => ({ default: m.CollabHomePage })));
const CollabGrantPage = lazy(() => import('./CollabPages.js').then((m) => ({ default: m.CollabGrantPage })));
const CollabAcceptPage = lazy(() => import('./CollabPages.js').then((m) => ({ default: m.CollabAcceptPage })));

const routes: FeatureRoute[] = [
  { path: '/collab', element: <CollabHomePage />, tier: 'workspace', archetype: 'standard-index' },
  { path: '/collab/accept/:token', element: <CollabAcceptPage />, tier: 'workspace', archetype: 'narrow-form' },
  { path: '/collab/:grantId', element: <CollabGrantPage />, tier: 'workspace', archetype: 'detail' },
];

export const collabFeature: FrontendFeature = { id: 'collab', routes };
