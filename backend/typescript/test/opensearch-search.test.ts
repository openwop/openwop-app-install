/**
 * ADR 0867 (durable storage tier: the `opensearch` search engine) — the OpenSearch search
 * adapter's request/response contract (`host/search/openSearchSearch.ts`,
 * selected with OPENWOP_SURFACE_SEARCH=opensearch; the index-name mapping itself is pinned in
 * `opensearch-index-name-injective.test.ts`, the `cdbda0ef5` fix).
 *
 * What it guards: each tenant's docs land in, and are read from, its OWN physical index; a
 * never-created index reads as empty (404 → no hits), not as a failure; the engine's hit order
 * and `_source` reach the caller unchanged; delete counts only ids the engine really removed;
 * and an unconfigured adapter refuses to construct.
 *
 * Red when (sabotage-witnessed, w79): the tenant dropped from the `indexName` call (isolation
 * case); the 404 branch removed (missing-index + isolation cases); hits reversed or `_source`
 * dropped (order case); delete counting every bulk item (order/delete case); the `!cfg` guard
 * removed (config case).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SearchSurface } from '../src/host/inMemorySurfaces.js';
import { createOpenSearchSearch, type OpenSearchConfig } from '../src/host/search/openSearchSearch.js';

// A tiny fake OpenSearch: Map<physicalIndex, Map<id, fields>>, served over fetch.
function makeFakeOS() {
  const indices = new Map<string, Map<string, Record<string, unknown>>>();
  const idx = (name: string) => { let m = indices.get(name); if (!m) { m = new Map(); indices.set(name, m); } return m; };
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    const [, index, op] = u.pathname.split('/'); // ['', index, '_bulk'|'_search']
    if (op === '_bulk') {
      const lines = String(init.body).trim().split('\n').map((l) => JSON.parse(l));
      const items: unknown[] = [];
      const m = idx(index);
      for (let i = 0; i < lines.length; i++) {
        const action = lines[i] as Record<string, { _id: string }>;
        if (action.index) { m.set(action.index._id, lines[++i] as Record<string, unknown>); items.push({ index: { result: 'created' } }); }
        else if (action.delete) { const existed = m.delete(action.delete._id); items.push({ delete: { result: existed ? 'deleted' : 'not_found' } }); }
      }
      return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (op === '_search') {
      const m = indices.get(index);
      if (!m) return new Response(null, { status: 404 });
      const body = JSON.parse(String(init.body)) as { size: number; query: { multi_match: { query: string } } };
      const q = body.query.multi_match.query.toLowerCase();
      const hits = [...m.entries()]
        .map(([id, src]) => ({ _id: id, _score: Object.values(src).map(String).join(' ').toLowerCase().split(q).length - 1, _source: src }))
        .filter((h) => h._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, body.size);
      return new Response(JSON.stringify({ hits: { hits } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(null, { status: 400 });
  };
  return { indices, fetchFn };
}

/** The surface returns a free-form record; narrow its `hits` to the adapter's documented row shape. */
interface Hit { id: string; score: number; fields: unknown }
function hitsOf(r: Record<string, unknown>): Hit[] {
  expect(Array.isArray(r.hits), 'query answers a hits array').toBe(true);
  return r.hits as Hit[];
}

const CONFIG: OpenSearchConfig = { endpoint: 'http://os:9200', indexPrefix: 'owp-' };
const searchFor = (tenantId: string, fetchFn: typeof fetch): SearchSurface =>
  createOpenSearchSearch({ tenantId }, { fetch: fetchFn, config: CONFIG });

describe('OpenSearch search surface', () => {
  it("index + query keeps the engine's hit order and maps _id/_source; delete counts only removed ids", async () => {
    const { fetchFn } = makeFakeOS();
    const s = searchFor('t1', fetchFn);
    expect(await s.index({ index: 'docs', docs: [
      { id: '1', fields: { title: 'the quick brown fox' } },
      { id: '2', fields: { title: 'quick quick rabbit' } },
      { id: '3', fields: { title: 'slow turtle' } },
    ] })).toEqual({ indexed: 3 });
    const res = hitsOf(await s.query({ index: 'docs', q: 'quick' }));
    expect(res.map((h) => h.id)).toEqual(['2', '1']);
    expect(res[0]?.fields).toEqual({ title: 'quick quick rabbit' });
    // 'nope' was never indexed: the engine answers not_found for it, which is not a deletion.
    expect(await s.delete({ index: 'docs', ids: ['2', 'nope'] })).toEqual({ deleted: 1 });
    // Read back: the deleted doc is gone, the other one remains.
    expect(hitsOf(await s.query({ index: 'docs', q: 'quick' })).map((h) => h.id)).toEqual(['1']);
  });

  it('query on a never-created index returns no hits (404 handled)', async () => {
    const { fetchFn } = makeFakeOS();
    expect(await searchFor('t1', fetchFn).query({ index: 'missing', q: 'x' })).toEqual({ hits: [] });
  });

  it('isolates tenants via distinct physical indices', async () => {
    const { indices, fetchFn } = makeFakeOS();
    await searchFor('tenant-a', fetchFn).index({ index: 'docs', docs: [{ id: '1', fields: { t: 'secret' } }] });
    // tenant-b queries its own (empty) physical index
    expect(await searchFor('tenant-b', fetchFn).query({ index: 'docs', q: 'secret' })).toEqual({ hits: [] });
    // Independently derived (Python base64.b32encode, lowercased, unpadded), never the product's encoder.
    expect([...indices.keys()]).toEqual(['owp-v2.orsw4ylooqwwc.mrxwg4y']);
  });

  it('throws when constructed without config', () => {
    vi.stubEnv('OPENWOP_SEARCH_OS_ENDPOINT', '');
    try {
      expect(() => createOpenSearchSearch({ tenantId: 't' }, {}))
        .toThrow(/not configured — set OPENWOP_SEARCH_OS_ENDPOINT/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
