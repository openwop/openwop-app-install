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
 * (`physicalIndexName`), so no query can cross a tenant. The mapping is
 * INJECTIVE: two different (tenant, index) pairs never share a physical index.
 *
 * Config (env):
 *   OPENWOP_SEARCH_OS_ENDPOINT      (required, e.g. https://os.internal:9200)
 *   OPENWOP_SEARCH_OS_USERNAME/_PASSWORD  (basic auth) OR OPENWOP_SEARCH_OS_API_KEY
 *   OPENWOP_SEARCH_OS_INDEX_PREFIX  (default "openwop-")
 */

import { createHash } from 'node:crypto';
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

/** OpenSearch's ceiling on an index name, in bytes. */
export const OS_INDEX_NAME_MAX_BYTES = 255;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, unpadded: injective on byte strings, and its
 *  alphabet (`a-z2-7`) is inside OpenSearch's index-name charset and never
 *  contains the `.` separator. */
function base32(s: string): string {
  const bytes = Buffer.from(s, 'utf8');
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The physical OpenSearch index for one (tenant, index) pair.
 *
 * This used to be `<prefix><lower(tenant)>-<lower(index)>` with every other
 * character replaced by `-`. That mapping was lossy in three ways: tenant `a-b`
 * + index `c` and tenant `a` + index `b-c` shared one index (a cross-tenant
 * read), `Docs` and `docs` shared one, and a host index named `wf-x` shared the
 * index of a run's `x` (ADR 0998 stores it as `wf:x`).
 *
 * Now each segment is base32-encoded (case- and byte-preserving) and joined with
 * `.`, which base32 never emits, under a `v2.` scheme marker:
 * `<prefix>v2.<b32(tenant)>.<b32(index)>`. A pair too long for the 255-byte
 * limit falls back to `<prefix>h.<sha256(len(tenant):tenant index)>` (length-prefixed,
 * so the split is unambiguous); the two forms
 * cannot collide because they differ right after the constant prefix.
 */
export function physicalIndexName(prefix: string, tenantId: string, index: string): string {
  const name = `${prefix}v2.${base32(tenantId)}.${base32(index)}`;
  if (Buffer.byteLength(name, 'utf8') <= OS_INDEX_NAME_MAX_BYTES) return name;
  return `${prefix}h.${createHash('sha256').update(`${tenantId.length}:${tenantId}${index}`).digest('hex')}`;
}

interface SearchDoc { id: string; fields: Record<string, string | number | boolean> }

export function createOpenSearchSearch(scope: BundleScope, deps: OpenSearchDeps = {}): SearchSurface {
  const fetchFn = deps.fetch ?? fetch;
  const cfg = deps.config ?? loadOpenSearchConfigFromEnv().config;
  if (!cfg) {
    throw new Error('host.search backend "opensearch" selected but not configured — set OPENWOP_SEARCH_OS_ENDPOINT (+ auth).');
  }
  const indexName = (index: unknown) => physicalIndexName(cfg.indexPrefix, scope.tenantId, String(index ?? 'default'));
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
