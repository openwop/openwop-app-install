/**
 * kicktodo-accountability — consensual graduated accountability (ADR 0419).
 * P1: circles + grants + the resource-conversation binding seam.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoAccountabilityRoutes } from './routes.js';
import { registerKicktodoAccountabilityAgentTools } from './agentTools.js';
import { buildKicktodoAccountabilitySurface } from './surface.js';
import { registerKicktodoAccountabilityCompliance } from './compliance.js';
import { registerKicktodoAccountabilityApprovalHandler } from './planProposalApproval.js';

export const kicktodoAccountabilityFeature: BackendFeature = {
  id: 'kicktodo-accountability',
  registerRoutes: (deps) => {
    registerKicktodoAccountabilityRoutes(deps);
    registerKicktodoAccountabilityAgentTools(); // ADR 0419 P4
    // ADR 0458 Phase 0 — the ONE subject-eraser + retention-purger for this package
    // (registerRoutes runs for every feature regardless of toggle → erasable when off).
    registerKicktodoAccountabilityCompliance();
    // ADR 0459 P2 — the coach plan-proposal decide hook (participant-decided
    // approval card). Registered unconditionally at boot like every decide
    // handler so the core claim/reject path always resolves it.
    registerKicktodoAccountabilityApprovalHandler();
  },
  toggleDefault: {
    id: 'kicktodo-accountability',
    label: 'KickTodo Accountability',
    description:
      'Partner/circle/cohort/coach accountability: scope-explicit grants, shared circle conversations, immediate revocation (ADR 0419).',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-accountability',
  },
  dependsOn: ['kicktodo-core'],
  surface: { id: 'kicktodo-accountability', build: buildKicktodoAccountabilitySurface },
  requiredPacks: [
    { name: 'feature.kicktodo.nodes', version: '1.30.0' },
    { name: 'feature.kicktodo.agents', version: '1.9.0' },
  ],
};
