/**
 * KB workflow surface (ADR 0014 Phase 1) — the reference `ctx.features.kb` that
 * a workflow node calls. A THIN adapter over `kbService` (the single source of
 * truth shared with the REST face); it adds no domain logic. Tenant comes from
 * the run scope; `orgId`/`collectionId` are node-supplied and the SERVICE
 * enforces the tenant+org key (CTI-1) — a cross-tenant id is simply not found.
 * Intended to be called from `role:action` pack nodes (Phase 2), whose outputs
 * are recorded → replay/fork-safe.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listCollections, ragQuery, search, tenantRetrieve } from './kbService.js';

export function buildKbSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** Semantic search within one collection. */
    search: async (args) => {
      const results = await search(tenantId, str(args.orgId), str(args.collectionId), args.query, args.topK);
      return { results };
    },
    /** Retrieve → augmented prompt + citations (generation is the node's job). */
    rag: async (args) => {
      const r = await ragQuery(tenantId, str(args.orgId), str(args.collectionId), args.query, args.topK);
      return { query: r.query, contexts: r.contexts, citations: r.citations, augmentedPrompt: r.augmentedPrompt };
    },
    /** Tenant-wide retrieval across the tenant's collections (the host.knowledge
     *  shape); returns empty when the tenant has none. */
    retrieve: async (args) => {
      const res = await tenantRetrieve(tenantId, {
        query: str(args.query),
        ...(Array.isArray(args.collectionIds) ? { collectionIds: (args.collectionIds as unknown[]).map(str) } : {}),
        ...(typeof args.resultLimit === 'number' ? { resultLimit: args.resultLimit } : {}),
      });
      const r = res ?? { chunks: [], sources: [], latencyMs: 0, hasResults: false };
      return { chunks: r.chunks, sources: r.sources, latencyMs: r.latencyMs, hasResults: r.hasResults };
    },
    /** List the org's collections (read). */
    listCollections: async (args) => {
      return { collections: await listCollections(tenantId, str(args.orgId)) };
    },
  };
}
