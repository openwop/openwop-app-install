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
 *     store. `ingestDocument` writes a cited document there. This is NOT a
 *     `ctx.memory` write and touches no normative wire contract, so it needs no
 *     RFC. It is the write path the ADR 0038 §B trigger→workflow auto-ingest node
 *     calls.
 *
 *     CORRECTION 2026-08-19 (WF-AKM-1 / ADR 0587 §7): this used to read "a
 *     `role:action` side-effect (recorded; replay/fork read the recorded result,
 *     no double ingest)". The executor NEVER reads `role`
 *     (`git grep "role === 'action'" -- src/executor/` → zero), and the node was
 *     in none of the three side-effect sets, so a `:fork` re-ingested a SECOND
 *     document. The node is now `role:"side-effect"` + `side-effectful` in its
 *     manifest AND carries an explicit typeId entry in `executor/sideEffects.ts`.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { retrieveForAgent, ingestDocToBoundCollection } from './service.js';

export function buildAgentKnowledgeSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** Retrieve the agent's bound knowledge (cited KB chunks + private memory
     *  facts) for a query. Read-only, so replay-safe by nature — NOT because of
     *  its node's `role` (nothing in the executor reads `role`; see the module
     *  docblock's WF-AKM-1 correction).
     *
     *  `failedSources` is PROJECTED, not dropped (KB-UX-3 / ADR 0583). This
     *  surface's consumer is a workflow node whose output a MODEL reads, and
     *  the two REST previews already report it. Dropping it here left exactly
     *  the lie the finding closed, on the lane where it is worst: a faulted KB
     *  backend arriving at a model as `hasResults:false` — indistinguishable
     *  from an empty corpus — so the model confidently answers "there is
     *  nothing in your knowledge base". `[]` on the happy path, so a chain that
     *  ignores it is unaffected. */
    retrieve: async (args) => {
      // No caller (ADR 0643 R3/R4 Blocker 2 classification): this is the RUN lane,
      // where the binding is read as the owner-scoped grant it is — the HTTP reads
      // re-resolve the reader; a run has no reader to re-resolve.
      //
      // ADR 0664 D6 — this said "the FOUR HTTP reads". There were FIVE:
      // `routes/agents.ts:327` (agent dispatch) holds `req.userId` and passed no
      // caller, on a different router, which is how the count stayed wrong. Fixed
      // there; the claim here is no longer a number that can silently drift.
      //
      // ADR 0664 AGKM-10 (recorded, NOT fixed here) — `args.agentId` is
      // caller-supplied and un-gated, so a workflow author can name ANY roster
      // agent and read its bound corpora into a run output. That is wider than
      // R3's "the people who use the agent" premise; see the ADR.
      const res = await retrieveForAgent(tenantId, str(args.agentId), str(args.query));
      // WF-AKM-3 — `unavailable` distinguishes "capability off" / "nothing bound"
      // from an empty corpus. A missing agent never reaches here: it throws.
      // Omitted on the happy path, so a chain that ignores it is unaffected.
      return {
        chunks: res.chunks,
        hasResults: res.hasResults,
        failedSources: res.failedSources,
        ...(res.unavailable ? { unavailable: res.unavailable } : {}),
      };
    },
    /** Ingest a cited document into a collection BOUND to the agent (KB-document
     *  side only — never memory). The write path for ADR 0038 §B trigger→workflow
     *  auto-ingest. SIDE-EFFECTING: replay/fork are served the recorded outcome
     *  because the node is classified in BOTH the manifest floor and the typeId
     *  list — not because of any `role:action` semantics (WF-AKM-1). The actor is the run
     *  (provenance); the collection must be bound (cross-tenant impossible —
     *  tenant is scope-baked). */
    ingestDocument: async (args) => {
      const actor = scope.runId ? `run:${scope.runId}` : 'agent-knowledge-node';
      // Fail-CLOSED: only an explicit 'trusted' is trusted; anything absent/unknown
      // is treated as untrusted (ADR 0038 §C / RFC 0021). The node passes 'trusted'
      // for a direct workflow invocation and 'untrusted' on the trigger path; a
      // caller that omits it does NOT silently launder untrusted content as trusted.
      // The node decides its side from `ctx.trustBoundary` (WF-AKM-2), never from
      // the shape of `ctx.inputs`; this remains the fail-closed backstop.
      const contentTrust = optStr(args.contentTrust) === 'trusted' ? 'trusted' : 'untrusted';
      const doc = await ingestDocToBoundCollection(tenantId, actor, str(args.agentId), str(args.collectionId), {
        title: optStr(args.title),
        text: str(args.text),
        contentTrust,
        // ADR 0617 D1a / ADR 0643 D3 — the run's origin, so a binding on THIS run's
        // workflow is skipped by the dispatcher's self-trigger guard.
        origin: {
          ...(scope.runId ? { runId: scope.runId } : {}),
          ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
          ...(scope.chainId ? { chainId: scope.chainId } : {}),
        },
      });
      return { documentId: doc.documentId, title: doc.title, chunkCount: doc.chunkCount };
    },
  };
}
