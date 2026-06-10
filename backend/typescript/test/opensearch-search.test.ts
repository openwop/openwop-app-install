import { describe, expect, it } from 'vitest';
import type { SearchSurface } from '../src/host/inMemorySurfaces.js';
import { createOpenSearchSearch, type OpenSearchConfig } from '../src/host/search/openSearchSearch.js';

// A tiny fake OpenSearch: Map<physicalIndex, Map<id, fields>>, served over fetch.
function makeFakeOS() {
  const indices = new Map<string, Map<string, Record<string, unknown>>>();
  const idx = (name: string) => { let m = indices.get(name); if (!m) { m = new Map(); indices.set(name, m); } return m; };
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
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
  }) as unknown as typeof fetch;
  return { indices, fetchFn };
}

const CONFIG: OpenSearchConfig = { endpoint: 'http://os:9200', indexPrefix: 'owp-' };
const searchFor = (tenantId: string, fetchFn: typeof fetch): SearchSurface =>
  createOpenSearchSearch({ tenantId }, { fetch: fetchFn, config: CONFIG });

describe('OpenSearch search surface', () => {
  it('index + query ranks by term frequency; delete removes', async () => {
    const { fetchFn } = makeFakeOS();
    const s = searchFor('t1', fetchFn);
    expect(await s.index({ index: 'docs', docs: [
      { id: '1', fields: { title: 'the quick brown fox' } },
      { id: '2', fields: { title: 'quick quick rabbit' } },
      { id: '3', fields: { title: 'slow turtle' } },
    ] })).toEqual({ indexed: 3 });
    const res = await s.query({ index: 'docs', q: 'quick' }) as { hits: Array<{ id: string; fields: unknown }> };
    expect(res.hits.map((h) => h.id)).toEqual(['2', '1']);
    expect(res.hits[0].fields).toEqual({ title: 'quick quick rabbit' });
    expect(await s.delete({ index: 'docs', ids: ['2'] })).toEqual({ deleted: 1 });
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
    expect([...indices.keys()]).toContain('owp-tenant-a-docs');
  });

  it('throws when constructed without config', () => {
    expect(() => createOpenSearchSearch({ tenantId: 't' }, { config: null as unknown as OpenSearchConfig }))
      .toThrow(/not configured/);
  });
});
