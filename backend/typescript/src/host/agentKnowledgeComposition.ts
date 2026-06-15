/**
 * Per-agent knowledge composition into dispatch (ADR 0038 Phase 3) — host route
 * layer.
 *
 * Builds the `AgentKnowledgeRetrieve` that the live dispatch turn injects, from
 * three HOST-OWNED primitives:
 *   - `agentProfile.knowledge` (the binding — ADR 0031/0038, host store)
 *   - the `KnowledgeBackend` seam (cited KB docs — ADR 0011/0014, installed by
 *     the `kb` feature at boot; read via `getKnowledgeBackend()`, NOT imported)
 *   - the `AgentMemoryPort` (the agent's private RFC-0004 memory namespace)
 *
 * Because every input is host-owned, the composition lives here in the host —
 * NOT in the `agent-knowledge` feature — so core dispatch needs no core→feature
 * import (ADR 0038 § "Seam map"). Returns `undefined` when the agent has no
 * `knowledge` capability or no binding ⇒ dispatch behaves exactly as today.
 *
 * @see docs/adr/0038-per-agent-knowledge-memory.md §"Seam map" / Phase 3
 */

import type { AgentKnowledgeRetrieve, AgentMemoryPort } from './agentDispatch.js';
import { getAgentProfile } from './agentProfileService.js';
import { getKnowledgeBackend } from './knowledgeSurface.js';

/** Default top-K bound knowledge chunks injected per turn (when the binding does
 *  not set its own `retrieval.topK`). */
const DEFAULT_KNOWLEDGE_TOP_K = 6;

/**
 * Resolve the per-agent knowledge retriever for a live dispatch turn, or
 * `undefined` when there is nothing bound (so the caller injects nothing).
 *
 * Tenant isolation (CTI-1): `tenantId` is bound from the request principal and
 * threaded into every read — the KB backend buckets by tenant, the memory port
 * is tenant-bound at construction, and the profile read is cross-tenant
 * fail-closed. The retriever is READ-ONLY (RFC 0004 / ADR 0038 §9): it never
 * writes memory or KB.
 */
export async function resolveAgentKnowledgeRetrieve(
  tenantId: string,
  agentId: string,
  memory: AgentMemoryPort,
  memoryScope: string,
): Promise<AgentKnowledgeRetrieve | undefined> {
  const profile = await getAgentProfile(tenantId, agentId);
  // Capability + binding are the opt-in. No `knowledge` capability, or an empty
  // binding ⇒ nothing to compose (fail-closed: an absent profile is no binding).
  if (!profile || !(profile.capabilities ?? []).includes('knowledge')) return undefined;
  const binding = profile.knowledge;
  const collectionIds = binding?.collectionIds ?? [];
  const sources = binding?.retrieval?.sources ?? ['kb', 'memory'];
  const wantKb = sources.includes('kb') && collectionIds.length > 0;
  const wantMemory = sources.includes('memory');
  if (!wantKb && !wantMemory) return undefined;

  const topK =
    typeof binding?.retrieval?.topK === 'number' && binding.retrieval.topK > 0
      ? Math.floor(binding.retrieval.topK)
      : DEFAULT_KNOWLEDGE_TOP_K;
  const backend = getKnowledgeBackend();

  return async (query: string) => {
    const out: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust: 'trusted' | 'untrusted' }> = [];

    // KB collections — cited docs (ADR 0011). Each chunk carries its document's
    // content-trust (ADR 0038 §C) so dispatch fences untrusted (provider/trigger-
    // derived) content. Best-effort: a backend miss / error contributes nothing.
    if (wantKb && backend) {
      try {
        const res = await backend.retrieve(tenantId, { query, collectionIds, resultLimit: topK });
        if (res) {
          for (const chunk of res.chunks) {
            out.push({
              content: chunk.content,
              title: chunk.documentTitle,
              kind: 'kb',
              contentTrust: chunk.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
            });
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // Private per-agent memory facts (RFC 0004). Recalled by relevance; no title
    // (these are notes, not cited documents). Memory is the tenant's own curated
    // notes / prior-run summaries → trusted, EXCEPT a summary derived from
    // untrusted knowledge (ADR 0038 §C), which the port surfaces as
    // contentTrust:'untrusted' so it stays fenced here too.
    if (wantMemory) {
      try {
        const entries = await memory.read(memoryScope, query);
        for (const e of entries.slice(0, topK)) {
          out.push({ content: e.content, kind: 'memory', contentTrust: e.contentTrust === 'untrusted' ? 'untrusted' : 'trusted' });
        }
      } catch {
        /* best-effort */
      }
    }

    return out;
  };
}
