/**
 * kicktodo-creator — the Challenge Factory (ADR 0415; PRD §7).
 *
 * D1 scope: candidate intake with deterministic risk classification
 * (prohibited topics refused), the research/evidence spine (fail-closed on
 * stub/demo retrieval), and the research builtin workflow. Plan generation/
 * decomposition (D2), rights + N-gate publication (D3), and monitoring/studio
 * (D4) layer on top. Publishes INTO `kicktodo-core`'s ChallengeDefinition
 * owner — never a second challenge store.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoCreatorRoutes } from './routes.js';
import { registerKicktodoCreatorArtifactTypes } from './artifactSchemas.js';
import { registerKicktodoCreatorAgentTools } from './agentTools.js';
import { buildKicktodoCreatorSurface } from './surface.js';
import { registerCandidateDeathSubscribers } from './candidateDeathSubscribers.js';
import { registerKicktodoMonitorExceptionSource } from './exceptionSources.js';

export const kicktodoCreatorFeature: BackendFeature = {
  id: 'kicktodo-creator',
  registerRoutes: (deps) => {
    registerKicktodoCreatorRoutes(deps);
    registerKicktodoCreatorArtifactTypes(); // ADR 0415 P2 — the plan contract
    // ADR 0458 P1 — the Challenge Author's two chat tools. Registration is
    // process-wide (per-tenant toggle honesty lives in each tool's authority
    // check); the run-starter deps ride the closure (the workflowComposeTool
    // pattern) since a chat-time tool scope carries no `storage`/`hostSuite`.
    registerKicktodoCreatorAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
    // ADR 0458 grade-pass I2 — clean up a killed candidate's outline canvas +
    // lesson media on the terminal `withdrawn` flip (keyed, idempotent, best-effort).
    registerCandidateDeathSubscribers();
    // ADR 0460 Phase 2 — the monitor-findings feed of the admin Exception Ledger
    // (published challenges whose source-health monitor found broken citations).
    registerKicktodoMonitorExceptionSource();
  },
  toggleDefault: {
    id: 'kicktodo-creator',
    label: 'KickTodo Creator',
    description:
      'The Challenge Factory: governed research → evidence → plan → gated publication of KickTodo challenges (ADR 0415). Editor/publisher authorization stays fail-closed.',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-creator',
  },
  dependsOn: ['kicktodo-core'],
  surface: { id: 'kicktodo-creator', build: buildKicktodoCreatorSurface },
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
};
