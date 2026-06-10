/**
 * OpenSearch / Elasticsearch-backed search host surface (Phase 2 scale engine) —
 * `host.db.search` over a real full-text engine via its HTTP API, selected with
 * `OPENWOP_SURFACE_SEARCH=opensearch`.
 *
 * The scale answer the architecture review called for: BM25 relevance + real
 * indexing instead of the durable-but-O(n) bag-of-words. Dependency-free
 * (global `fetch`); compatible with OpenSearch and Elasticsearch 7/8 (the
 * `_bulk` + `_search`/`multi_match` surface used here is common to both).
 *
 * Tenant isolation: each (tenant, index) maps to its own physical OS index
 * `<prefix><tenant>-<index>` (lowercased), so no query can cross a tenant.
 *
 * Config (env):
 *   OPENWOP_SEARCH_OS_ENDPOINT      (required, e.g. https://os.internal:9200)
 *   OPENWOP_SEARCH_OS_USERNAME/_PASSWORD  (basic auth) OR OPENWOP_SEARCH_OS_API_KEY
 *   OPENWOP_SEARCH_OS_INDEX_PREFIX  (default "openwop-")
 */

import type { BundleScope, SearchSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';

export const OPENSEARCH_BACKEND_ID = 'opensearch';

export interface OpenSearchConfig {
  endpoint: string;
  authHeader?: string;
  indexPrefix: string;
}

export interface OpenSearchDeps {
  fetch?: typeof fetch;
  config?: OpenSearchConfig;
}

export function loadOpenSearchConfigFromEnv(): { config: OpenSearchConfig | null; missing: string[] } {
  const env = process.env;
  if (!env.OPENWOP_SEARCH_OS_ENDPOINT) return { config: null, missing: ['OPENWOP_SEARCH_OS_ENDPOINT'] };
  let authHeader: string | undefined;
  if (env.OPENWOP_SEARCH_OS_API_KEY) {
    authHeader = `ApiKey ${env.OPENWOP_SEARCH_OS_API_KEY}`;
  } else if (env.OPENWOP_SEARCH_OS_USERNAME && env.OPENWOP_SEARCH_OS_PASSWORD) {
    authHeader = `Basic ${Buffer.from(`${env.OPENWOP_SEARCH_OS_USERNAME}:${env.OPENWOP_SEARCH_OS_PASSWORD}`).toString('base64')}`;
  }
  return {
    config: {
      endpoint: env.OPENWOP_SEARCH_OS_ENDPOINT.replace(/\/+$/, ''),
      authHeader,
      indexPrefix: env.OPENWOP_SEARCH_OS_INDEX_PREFIX || 'openwop-',
    },
    missing: [],
  };
}

const osName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '-');

interface SearchDoc { id: string; fields: Record<string, string | number | boolean> }

export function createOpenSearchSearch(scope: BundleScope, deps: OpenSearchDeps = {}): SearchSurface {
  const fetchFn = deps.fetch ?? fetch;
  const cfg = deps.config ?? loadOpenSearchConfigFromEnv().config;
  if (!cfg) {
    throw new Error('host.search backend "opensearch" selected but not configured — set OPENWOP_SEARCH_OS_ENDPOINT (+ auth).');
  }
  const indexName = (index: unknown) => `${cfg.indexPrefix}${osName(scope.tenantId)}-${osName(String(index ?? 'default'))}`;
  const headers = (ct = 'application/json') => {
    const h: Record<string, string> = { 'content-type': ct };
    if (cfg.authHeader) h.authorization = cfg.authHeader;
    return h;
  };

  async function bulk(index: unknown, lines: string[]): Promise<Response> {
    return fetchFn(`${cfg!.endpoint}/${indexName(index)}/_bulk?refresh=wait_for`, {
      method: 'POST', headers: headers('application/x-ndjson'), body: lines.join('\n') + '\n',
    });
  }

  return {
    async index({ index, docs }) {
      const arr = docs as SearchDoc[];
      if (arr.length === 0) return { indexed: 0 };
      const lines: string[] = [];
      for (const d of arr) {
        lines.push(JSON.stringify({ index: { _id: d.id } }));
        lines.push(JSON.stringify(d.fields));
      }
      const res = await bulk(index, lines);
      if (!res.ok) throw new Error(`opensearch index failed: HTTP ${res.status}`);
      return { indexed: arr.length };
    },

    async query({ index, q, k }) {
      const size = typeof k === 'number' && k > 0 ? k : 10;
      const res = await fetchFn(`${cfg!.endpoint}/${indexName(index)}/_search`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ size, query: { multi_match: { query: String(q ?? ''), fields: ['*'] } } }),
      });
      if (res.status === 404) return { hits: [] }; // index not created yet
      if (!res.ok) throw new Error(`opensearch query failed: HTTP ${res.status}`);
      const body = await res.json() as { hits?: { hits?: Array<{ _id: string; _score: number; _source: Record<string, unknown> }> } };
      const hits = (body.hits?.hits ?? []).map((h) => ({ id: h._id, score: h._score, fields: h._source }));
      return { hits };
    },

    async delete({ index, ids }) {
      const arr = ids as string[];
      if (arr.length === 0) return { deleted: 0 };
      const lines = arr.map((id) => JSON.stringify({ delete: { _id: id } }));
      const res = await bulk(index, lines);
      if (!res.ok) throw new Error(`opensearch delete failed: HTTP ${res.status}`);
      const body = await res.json() as { items?: Array<{ delete?: { result?: string } }> };
      const deleted = (body.items ?? []).filter((it) => it.delete?.result === 'deleted').length;
      return { deleted };
    },
  };
}

export function registerOpenSearchAdapter(): void {
  registerSurfaceAdapter('search', OPENSEARCH_BACKEND_ID, (scope: BundleScope) => createOpenSearchSearch(scope));
  if (resolveBackendId('search') === OPENSEARCH_BACKEND_ID) {
    const { config, missing } = loadOpenSearchConfigFromEnv();
    if (!config) {
      throw new Error(
        `OPENWOP_SURFACE_SEARCH=opensearch but missing required config: ${missing.join(', ')}. ` +
          'Set it, or unset OPENWOP_SURFACE_SEARCH to use the in-memory/durable search.',
      );
    }
  }
}
