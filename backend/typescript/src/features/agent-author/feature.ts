/**
 * Agent Author (ADR 0514) — describe-to-create for the digital workforce: the
 * one dimension where every agent-platform leader beat us (the agents round-2
 * matrix). The Workflow Architect shape exactly — a closed-world catalog, a
 * draft/validate pipeline with ONE bounded repair, and persistence through the
 * SHARED `createRosterEntry` path with the created agent landing DISABLED for
 * human review (the field's draft-never-auto-activate consensus).
 *
 * Toggle default OFF (ADR 0514 §4): the Agent Author appears only when the
 * pack is installed AND this toggle is on. The tools are NOT in the ADR 0315
 * default-on baseline — they reach a model only via the pack's allowlist.
 *
 * RFC gate: host work only (roster + agent registry are host-extension
 * surfaces) — NO new RFC.
 *
 * @see docs/adr/0514-agent-author-describe-to-create.md
 */

import type { BackendFeature } from '../types.js';
import { registerAgentAuthorAgentTools } from './agentTools.js';
import { registerAgentAuthorRoutes } from './routes.js';
import { buildAgentAuthorSurface } from './surface.js';

export const agentAuthorFeature: BackendFeature = {
  id: 'agent-author',
  registerRoutes: (deps) => {
    // The chat tools ARE the authoring surface (ADR 0058: chat-drivability =
    // agent + nodes; ADR 0308 D2 registration lifecycle). The two OQ1 routes
    // are ONLY the wizard's read/dismiss of the caller's own draft stash —
    // self-scoped, sharing the persist tool's acting-user predicate.
    registerAgentAuthorAgentTools();
    registerAgentAuthorRoutes(deps.app);
  },
  surface: { id: 'agent-author', build: buildAgentAuthorSurface },
  toggleDefault: {
    id: 'agent-author',
    label: 'Agent Author (describe-to-create)',
    description: 'Create roster agents from a natural-language description in the AI chat. Created agents land disabled pending review (ADR 0514).',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'agent-author',
  },
  requiredPacks: [
    { name: 'feature.agent-author.nodes', version: '1.1.0' },
    { name: 'feature.agent-author.agents', version: '1.1.0' },
  ],
};
