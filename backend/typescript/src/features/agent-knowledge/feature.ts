/**
 * Agent Knowledge & Memory (ADR 0038). A THIN feature-package that COMPOSES the
 * existing primitives into a user-curatable per-agent knowledge surface:
 *   - documents → a KB collection BOUND to the agent (cited RAG, ADR 0011);
 *   - notes/facts → the agent's RFC-0004 memory namespace (recalled, ADR 0023/0004);
 *   - binding + capability → `agentProfile.knowledge` + the core `knowledge`
 *     capability (ADR 0031/0036).
 *
 * Adds NO new store and NO parallel architecture (ADR 0038 § "PRD-vs-architecture
 * corrections"). The dispatch-retrieval composition lives in the HOST route layer
 * (`host/agentKnowledgeComposition.ts`) reading host-owned primitives, so there
 * is no feature→core up-import. ALWAYS-ON: graduated off its `agent-knowledge`
 * toggle 2026-06-16 (ADR 0038 § Correction) — per-agent knowledge is core agent
 * infrastructure, like `profiles` / Personal Memory; routes gate on identity +
 * IDOR + RBAC + profile policy, not a toggle.
 *
 * @see docs/adr/0038-per-agent-knowledge-memory.md
 */

import type { BackendFeature } from '../types.js';
import { registerAgentKnowledgeRoutes } from './routes.js';
import { buildAgentKnowledgeSurface } from './surface.js';
import { registerWorkflow } from '../../host/workflowsRegistry.js';

/** The demo auto-ingest workflow (ADR 0038 §B): trigger (webhook/email/form,
 *  RFC 0099) → this → the ingest node → UNTRUSTED cited KB doc. A single
 *  feature-pack-node workflow, so it lives in the builder workflow registry —
 *  NOT `WORKFLOW_TEMPLATES`, which is core-nodes-only + universally runnable.
 *  The demo subscription (`exampleDataSeed`) binds this id. */
export const AUTO_INGEST_WORKFLOW_ID = 'feature.agent-knowledge.auto-ingest';

export const agentKnowledgeFeature: BackendFeature = {
  id: 'agent-knowledge',
  registerRoutes: (deps) => {
    registerAgentKnowledgeRoutes(deps);
    // Register the §B auto-ingest workflow into the catalog (idempotent). Present
    // whenever the feature is composed, so a trigger subscription can resolve it.
    registerWorkflow({
      workflowId: AUTO_INGEST_WORKFLOW_ID,
      nodes: [{ nodeId: 'ingest', typeId: 'feature.agent-knowledge.nodes.ingest', outputRole: 'primary' }],
      edges: [],
    });
  },
  // Face 2 (ADR 0014 Phase 1): the typed, READ-ONLY `ctx.features.agent-knowledge`
  // workflow surface (advertised at /.well-known/openwop via the surface registry).
  surface: { id: 'agent-knowledge', build: buildAgentKnowledgeSurface },
  // No `toggleDefault` — graduated to always-on (§ header). The id is retired in
  // features/index.ts RETIRED_TOGGLE_IDS so a stale durable override is cleared.
  // Face 3 (ADR 0014 Phase 2): the node pack over ctx.features.agentKnowledge —
  // `retrieve` (read) + `ingest` (KB-document write; ADR 0038 §B trigger→workflow
  // auto-ingest). No agent pack (this is agent infrastructure, not an AI surface).
  requiredPacks: [{ name: 'feature.agent-knowledge.nodes', version: '1.1.0' }],
};
