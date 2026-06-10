/**
 * A4 — a concrete `AgentMemoryPort` (RFC 0004) over the host's tenant-scoped
 * memory store, so a live agent turn can read prior-run memory into its context
 * and write a turn summary back (the dispatch wiring in `agentDispatch.ts`
 * gates this on the agent declaring `memoryShape.longTerm`).
 *
 * Backing: the in-memory RFC 0004 store (`writeMemoryEntry`/`listMemoryEntries`
 * in `inMemorySurfaces.ts`), the same store the demo read routes (`routes/memory.ts`)
 * serve. Tenant isolation (CTI-1) is enforced by BINDING `tenantId` at
 * construction from the request principal — the caller never passes a tenant
 * through the `scope` argument, so a read/write can't cross a tenant boundary.
 * The `scope` argument is the per-agent memory namespace (`memoryRef`).
 *
 * SR-1 (no credential material in memory) is the writer's responsibility; this
 * adapter persists exactly the content it is handed.
 *
 * A5 (RAG) — every write is ALSO embedded (`embedText`, dim `DEFAULT_EMBEDDING_DIMS`)
 * and upserted into the host's `host.db.vector` cosine store under the same
 * tenant+scope namespace. A `read(scope, query)` then embeds the query at the
 * SAME dimension and returns the top-K most-similar entries; `read(scope)` with
 * no query (or an empty vector store) falls back to the recency listing. The
 * vector surface is already advertised `supported: true` at runtime
 * (initInMemorySurfaces registers the brute-force-cosine backend), so this wires
 * an already-real surface into recall — no advertisement change.
 */

import { randomUUID } from 'node:crypto';
import type { AgentMemoryPort } from './agentDispatch.js';
import { writeMemoryEntry, listMemoryEntries, buildHostSurfaceBundle } from './inMemorySurfaces.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../aiProviders/localEmbedding.js';

/** Top-K entries a RAG recall returns into the turn's context. */
const RAG_TOP_K = 8;

/** Stable per-agent memory namespace within a tenant. Keeps each agent's
 *  long-term memory isolated from the demo `MEMORY_DEMO_REF` surface and from
 *  other agents in the same tenant. */
export function agentMemoryScope(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * Build an `AgentMemoryPort` bound to one tenant. `read(scope)` returns the
 * scope's entries newest-first (the store's natural order, TTL-filtered);
 * `write(scope, entry)` appends a durable entry. Both are best-effort from the
 * dispatcher's perspective — it already degrades gracefully on a throw.
 */
export function createAgentMemoryPort(tenantId: string): AgentMemoryPort {
  // The tenant-scoped vector surface (CTI-1: the cosine store buckets by
  // tenantId, so a query can't reach another tenant's vectors). Built once per
  // port; the underlying state is process-global so writes persist across ports.
  const vector = buildHostSurfaceBundle({ tenantId }).db.vector;

  const recency = (scope: string): Array<{ content: string }> =>
    listMemoryEntries(tenantId, scope).map((e) => ({ content: e.content }));

  return {
    async read(scope: string, query?: string): Promise<ReadonlyArray<{ content: string }>> {
      // RAG path: rank by embedding cosine similarity to the query. Embed at the
      // SAME dimension used on write (DEFAULT_EMBEDDING_DIMS) so cosine is valid.
      if (query && query.trim().length > 0) {
        try {
          const res = await vector.query({
            namespace: scope,
            vector: embedText(query, DEFAULT_EMBEDDING_DIMS),
            topK: RAG_TOP_K,
          });
          const matches = (res.matches ?? []) as Array<{ metadata?: { content?: unknown } }>;
          const ranked = matches
            .map((m) => m.metadata?.content)
            .filter((c): c is string => typeof c === 'string');
          if (ranked.length > 0) return ranked.map((content) => ({ content }));
          // Vector store empty for this scope (e.g. entries seeded pre-A5) → recency.
        } catch {
          /* fall through to recency on any vector-store error */
        }
      }
      return recency(scope);
    },
    async write(scope: string, entry: { content: string; tags?: string[] }): Promise<void> {
      const row = writeMemoryEntry(tenantId, scope, {
        content: entry.content,
        ...(entry.tags ? { tags: entry.tags } : {}),
      });
      // Index for RAG recall — best-effort; a vector-store failure never loses the
      // durable write above. id mirrors the memory-store row id when present.
      try {
        await vector.upsert({
          namespace: scope,
          items: [{
            id: row?.id ?? `mem_${randomUUID().slice(0, 12)}`,
            vector: embedText(entry.content, DEFAULT_EMBEDDING_DIMS),
            metadata: { content: entry.content },
          }],
        });
      } catch {
        /* best-effort index */
      }
    },
  };
}
