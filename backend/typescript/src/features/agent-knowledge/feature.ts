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
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';

/** The demo auto-ingest workflow (ADR 0038 §B): trigger (webhook/email/form,
 *  RFC 0099) → this → the ingest node → UNTRUSTED cited KB doc. The demo
 *  subscription (`exampleDataSeed`) binds this id.
 *
 *  WF-KB-1 (CORRECTION). This used to be an in-tree `registerWorkflow({...})`
 *  literal, and the comment here claimed it therefore "lives in the builder
 *  workflow registry". That was FALSE: `registerWorkflow` writes a `wfreg:` row
 *  and nothing else, while `/builder` and the `/` picker both list only the
 *  tenant OWNERSHIP index — so the workflow was invisible in both, uneditable,
 *  and unreachable by `purgeTenantOwnedWorkflowDefs` at account deletion. The
 *  sentence was the only thing that ever made the pin site look sanctioned.
 *
 *  It is now a one-node chain in `core.openwop.workflows.agent-knowledge`,
 *  registered chain-backed under the SAME id — so the seeded trigger
 *  subscription resolves unchanged, replay is unchanged, and the workflow is a
 *  first-class gallery template a tenant can instantiate and edit. */
export const AUTO_INGEST_WORKFLOW_ID = 'feature.agent-knowledge.auto-ingest';

export const agentKnowledgeFeature: BackendFeature = {
  id: 'agent-knowledge',
  registerRoutes: (deps) => {
    registerAgentKnowledgeRoutes(deps);
    // WF-KB-1 — chainId-ONLY registration (the ADR 0472 guardrail: this API
    // cannot accept a raw WorkflowDefinition, so the anti-pattern is not
    // expressible here). Idempotent; soft-fails loudly if the pack is missing.
    registerChainBackedWorkflow(AUTO_INGEST_WORKFLOW_ID);
  },
  // Face 2 (ADR 0014 Phase 1): the typed, READ-ONLY `ctx.features.agent-knowledge`
  // workflow surface (advertised at /.well-known/openwop via the surface registry).
  surface: { id: 'agent-knowledge', build: buildAgentKnowledgeSurface },
  // No `toggleDefault` — graduated to always-on (§ header). The id is retired in
  // features/index.ts RETIRED_TOGGLE_IDS so a stale durable override is cleared.
  // Face 3 (ADR 0014 Phase 2): the node pack over ctx.features.agentKnowledge —
  // `retrieve` (read) + `ingest` (KB-document write; ADR 0038 §B trigger→workflow
  // auto-ingest). No agent pack (this is agent infrastructure, not an AI surface).
  requiredPacks: [{ name: 'feature.agent-knowledge.nodes', version: '1.5.0' }],
};
