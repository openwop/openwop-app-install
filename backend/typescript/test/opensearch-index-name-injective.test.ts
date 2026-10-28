/**
 * The OpenSearch search adapter maps every (tenant, index) pair to its OWN
 * physical index — the mapping is injective.
 *
 * Why this exists: the adapter used to build `<prefix><tenant>-<index>` after
 * lowercasing and replacing every other character with `-`. Tenant `a-b` + index
 * `c` and tenant `a` + index `b-c` then shared one physical index (a cross-tenant
 * read), `Docs` and `docs` shared one, and a host index `wf-x` shared the index a
 * run's `x` lands in (ADR 0998 stores it as `wf:x`). Not live: prod search is the
 * durable backend; this is the adapter an operator selects with
 * OPENWOP_SURFACE_SEARCH=opensearch.
 *
 * Sabotage-witnessed: with the old `osName` mapping restored, the three
 * collision legs and the end-to-end tenant leg go red.
 */
import { describe, expect, it } from 'vitest';
import { createOpenSearchSearch, physicalIndexName, OS_INDEX_NAME_MAX_BYTES } from '../src/host/search/openSearchSearch.js';
import { RUN_SURFACE_PREFIX } from '../src/host/runSurfaceNamespace.js';

const P = 'openwop-';
/** OpenSearch index-name rules: lowercase, no `\ / * ? " < > | , # :` or space, not starting `-`/`_`/`+`, ≤ 255 bytes. */
const VALID = /^[a-z0-9][a-z0-9._-]*$/;

describe('physicalIndexName is injective', () => {
  it('tenant `a-b` + index `c` and tenant `a` + index `b-c` get different indexes', () => {
    expect(physicalIndexName(P, 'a-b', 'c')).not.toBe(physicalIndexName(P, 'a', 'b-c'));
  });

  it("a host index can never encode into a run's wf: space", () => {
    for (const host of ['wf-chat', 'wf_chat', 'wf.chat', 'WF:chat', 'wf chat']) {
      expect(physicalIndexName(P, 't', host), host).not.toBe(physicalIndexName(P, 't', `${RUN_SURFACE_PREFIX}chat`));
    }
  });

  it('case-differing names stay distinct', () => {
    expect(physicalIndexName(P, 't', 'Docs')).not.toBe(physicalIndexName(P, 't', 'docs'));
    expect(physicalIndexName(P, 'User:ABC', 'i')).not.toBe(physicalIndexName(P, 'user:abc', 'i'));
  });

  it('a corpus of tricky pairs maps one-to-one, and every name is a valid OpenSearch index name', () => {
    const parts = ['', 'a', 'a-b', 'b-c', 'c', 'A', 'a.b', 'a_b', 'a:b', 'a/b', 'é', 'wf:x', 'wf-x', '.', '-', 'user:0123456789abcdef'];
    const seen = new Map<string, string>();
    for (const t of parts) {
      for (const i of parts) {
        const name = physicalIndexName(P, t, i);
        const key = JSON.stringify([t, i]);
        expect(seen.get(name), `${key} collides with ${seen.get(name)}`).toBeUndefined();
        seen.set(name, key);
        expect(name.slice(P.length)).toMatch(VALID);
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(OS_INDEX_NAME_MAX_BYTES);
      }
    }
  });

  it('an over-long pair falls back to a bounded hash name that is still distinct', () => {
    const long = 'x'.repeat(300);
    const a = physicalIndexName(P, long, 'i');
    const b = physicalIndexName(P, long, 'j');
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(Buffer.byteLength(n)).toBeLessThanOrEqual(OS_INDEX_NAME_MAX_BYTES);
      expect(n.slice(P.length)).toMatch(VALID);
    }
    // The split is length-prefixed, so moving a character across the boundary changes the name.
    expect(physicalIndexName(P, `${long}a`, 'b')).not.toBe(physicalIndexName(P, long, 'ab'));
  });
});

describe('the adapter routes each tenant to its own physical index', () => {
  it('tenant a-b indexing `c` is invisible to tenant a querying `b-c`', async () => {
    const store = new Map<string, Map<string, Record<string, unknown>>>();
    const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
      const [, index, op] = new URL(String(url)).pathname.split('/');
      const docs = store.get(index!) ?? new Map<string, Record<string, unknown>>();
      if (op === '_bulk') {
        const lines = String(init.body).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
        for (let n = 0; n < lines.length; n += 2) docs.set((lines[n]!.index as { _id: string })._id, lines[n + 1]!);
        store.set(index!, docs);
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (!store.has(index!)) return new Response('{}', { status: 404 });
      const hits = [...docs].map(([id, src]) => ({ _id: id, _score: 1, _source: src }));
      return new Response(JSON.stringify({ hits: { hits } }), { status: 200 });
    }) as typeof fetch;
    const config = { endpoint: 'http://os.test', indexPrefix: P };
    const tenantAB = createOpenSearchSearch({ tenantId: 'a-b' }, { fetch: fetchFn, config });
    const tenantA = createOpenSearchSearch({ tenantId: 'a' }, { fetch: fetchFn, config });

    await tenantAB.index({ index: 'c', docs: [{ id: 'secret', fields: { text: 'tenant a-b only' } }] });
    expect((await tenantAB.query({ index: 'c', q: 'tenant' })).hits).toHaveLength(1); // control
    expect((await tenantA.query({ index: 'b-c', q: 'tenant' })).hits).toEqual([]);
  });
});
