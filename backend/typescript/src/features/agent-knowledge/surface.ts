/**
 * Agent-knowledge workflow surface (ADR 0038 §3 / ADR 0014 Phase 1) — the
 * reference `ctx.features.agentKnowledge` a workflow node calls. A THIN,
 * READ-ONLY adapter over the curation service's `retrieveForAgent` (the single
 * source of truth shared with the REST face). Tenant comes from the run scope;
 * `agentId` is node-supplied and the host composition enforces the tenant-scoped
 * read (CTI-1) + the `knowledge` capability gate (an agent with no binding
 * returns empty). Toggle-gated at the registry seam (featureSurfaces.gate).
 *
 * Two backings, TWO rules (ADR 0038 §9, redrawn 2026-06-14):
 *   - the agent's **memory/notes** namespace (RFC 0004 `MemoryAdapter`) stays
 *     READ-ONLY on the wire — curation is a host-ext route, never a `ctx.memory`
 *     write. This surface NEVER writes memory.
 *   - a **bound KB collection** (ADR 0011) is a normal host-extension feature
 *     store. `ingestDocument` writes a cited document there — a `role:action`
 *     side-effect (recorded; replay/fork read the recorded result, no double
 *     ingest). This is NOT a `ctx.memory` write and touches no normative wire
 *     contract, so it needs no RFC. It is the write path the ADR 0038 §B
 *     trigger→workflow auto-ingest node calls.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { retrieveForAgent, ingestDocToBoundCollection } from './service.js';

export function buildAgentKnowledgeSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** Retrieve the agent's bound knowledge (cited KB chunks + private memory
     *  facts) for a query. Read-only; replay-safe (called from a recorded
     *  `role:action` node). */
    retrieve: async (args) => {
      const res = await retrieveForAgent(tenantId, str(args.agentId), str(args.query));
      return { chunks: res.chunks, hasResults: res.hasResults };
    },
    /** Ingest a cited document into a collection BOUND to the agent (KB-document
     *  side only — never memory). The write path for ADR 0038 §B trigger→workflow
     *  auto-ingest. `role:action` (recorded → replay-safe). The actor is the run
     *  (provenance); the collection must be bound (cross-tenant impossible —
     *  tenant is scope-baked). */
    ingestDocument: async (args) => {
      const actor = scope.runId ? `run:${scope.runId}` : 'agent-knowledge-node';
      // Fail-CLOSED: only an explicit 'trusted' is trusted; anything absent/unknown
      // is treated as untrusted (ADR 0038 §C / RFC 0021). The node passes 'trusted'
      // for a direct workflow invocation and 'untrusted' on the trigger path; a
      // caller that omits it does NOT silently launder untrusted content as trusted.
      const contentTrust = optStr(args.contentTrust) === 'trusted' ? 'trusted' : 'untrusted';
      const doc = await ingestDocToBoundCollection(tenantId, actor, str(args.agentId), str(args.collectionId), {
        title: optStr(args.title),
        text: str(args.text),
        contentTrust,
      });
      return { documentId: doc.documentId, title: doc.title, chunkCount: doc.chunkCount };
    },
  };
}
