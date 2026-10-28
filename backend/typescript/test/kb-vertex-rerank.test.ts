/**
 * ADR 0904 D8 / P7 (Track 2) — the Vertex ranking API as `rerank.kind:'vertex'`, built
 * INERT. Pinned, each sabotage-witnessed (revert → red → restore):
 *  - not selectable (422) unless the operator set OPENWOP_KB_VERTEX_RERANK=1;
 *  - the boot refuses it on with no per-tenant daily cap;
 *  - the request: one ranking call, the model, query, records with ids, topN, Bearer
 *    token from the metadata client; Vertex's ids and 0–1 scores come back best-first;
 *  - every failure (HTTP, 401 → token invalidated, cap reached, off) is `null`, and the
 *    search degrades to the local reranker, LABELLED `local-degraded`;
 *  - a reached daily cap makes no call at all.
 * The real search/RAG source-run and replay-fork witness lives in
 * `kb-paid-retrieval-replay.test.ts`, including a changed enrichment model.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollection, ingestDocument, searchDetailed, collectionQuality, KB_MAINTENANCE_CALLER, setRetrievalConfig } from '../src/features/kb/kbService.js';
import { assertVertexRerankBootConfig, vertexRerank, __setVertexRerankDepsForTest, type VertexRerankDeps } from '../src/features/kb/vertexReranker.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { GcpMetadataClient } from '../src/host/gcpAdc.js';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbvr-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(() => {
  __setVertexRerankDepsForTest(null);
  delete process.env.OPENWOP_KB_VERTEX_RERANK;
  delete process.env.OPENWOP_KB_VERTEX_RERANK_DAILY_CAP;
});

const ON = { OPENWOP_KB_VERTEX_RERANK: '1', OPENWOP_KB_VERTEX_RERANK_DAILY_CAP: '100', OPENWOP_VERTEX_PROJECT: 'proj-x' };
function md(): GcpMetadataClient & { invalidations: number } {
  const m = { invalidations: 0, accessToken: async () => 'tok', metadataText: async () => 'proj-md', invalidate: () => { m.invalidations += 1; } };
  return m;
}
function fake(status: number, body: unknown, seen: Array<{ url: string; body: Record<string, unknown>; auth: string }> = []): VertexRerankDeps['fetchImpl'] {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, auth: init.headers.authorization! });
    return { ok: status === 200, status, text: async () => JSON.stringify(body) };
  };
}
const DOCS = [{ id: 'a', text: 'alpha text', title: 'A' }, { id: 'b', text: 'beta text' }];
let n = 0;

describe('vertexRerank adapter', () => {
  it('sends one ranking call and returns Vertex’s order and 0–1 scores', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const out = await vertexRerank(`t-${n++}`, 'what about beta', DOCS, 2, { env: ON, metadata: md(), fetchImpl: fake(200, { records: [{ id: 'b', score: 0.91 }, { id: 'a', score: 0.12 }] }, seen) });
    expect(out).toEqual([{ id: 'b', score: 0.91 }, { id: 'a', score: 0.12 }]); // validated provider order
    expect(seen).toHaveLength(1);
    // ADR 0812 KEEP — Google's own REST API version (`googleapis.com/v1`), not the OpenWOP v1 wire.
    expect(seen[0]!.url).toBe('https://discoveryengine.googleapis.com/v1/projects/proj-x/locations/global/rankingConfigs/default_ranking_config:rank'); // ADR 0812 KEEP
    expect(seen[0]!.body).toEqual({ model: 'semantic-ranker-default-004', query: 'what about beta', topN: 2, records: [{ id: 'a', content: 'alpha text', title: 'A' }, { id: 'b', content: 'beta text' }] });
    expect(seen[0]!.auth).toBe('Bearer tok');
  });

  it.each([
    ['foreign id', [{ id: 'foreign', score: 0.7 }]],
    ['duplicate id', [{ id: 'a', score: 0.7 }, { id: 'a', score: 0.6 }]],
    ['missing score', [{ id: 'a' }]],
    ['string score', [{ id: 'a', score: '0.7' }]],
    ['negative score', [{ id: 'a', score: -0.1 }]],
    ['oversized score', [{ id: 'a', score: 1.1 }]],
    ['nonfinite score', [{ id: 'a', score: Infinity }]],
  ])('rejects a malformed ranking response: %s', async (_name, records) => {
    expect(await vertexRerank(`invalid-${n++}`, 'q', DOCS, 2, { env: ON, metadata: md(), fetchImpl: fake(200, { records }) })).toBeNull();
  });

  it('every failure is null; a 401 invalidates the token; off is null', async () => {
    const m = md();
    expect(await vertexRerank(`t-${n++}`, 'q', DOCS, 2, { env: ON, metadata: m, fetchImpl: fake(401, {}) })).toBeNull();
    expect(m.invalidations).toBe(1);
    expect(await vertexRerank(`t-${n++}`, 'q', DOCS, 2, { env: ON, metadata: md(), fetchImpl: fake(500, {}) })).toBeNull();
    expect(await vertexRerank(`t-${n++}`, 'q', DOCS, 2, { env: ON, metadata: md(), fetchImpl: async () => { throw new Error('timeout'); } })).toBeNull();
    expect(await vertexRerank(`t-${n++}`, 'q', DOCS, 2, { env: {}, metadata: md(), fetchImpl: fake(200, { records: [{ id: 'a', score: 1 }] }) })).toBeNull();
  });

  it('a reached daily cap makes no call', async () => {
    const t = `t-${n++}`;
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const env = { ...ON, OPENWOP_KB_VERTEX_RERANK_DAILY_CAP: '1' };
    expect(await vertexRerank(t, 'q', DOCS, 2, { env, metadata: md(), fetchImpl: fake(200, { records: [{ id: 'a', score: 1 }] }, seen) })).not.toBeNull();
    expect(await vertexRerank(t, 'q', DOCS, 2, { env, metadata: md(), fetchImpl: fake(200, { records: [{ id: 'a', score: 1 }] }, seen) })).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

describe('vertex rerank — config, boot and search wiring', () => {
  it('is not selectable unless the operator enabled it', async () => {
    const t = `t-${n++}`;
    const c = await createCollection(t, 'o', 'u', { name: 'c' });
    await expect(setRetrievalConfig(t, 'o', c.collectionId, 'u', { mode: 'hybrid+rerank', rerank: { kind: 'vertex' } })).rejects.toMatchObject({ httpStatus: 422 });
    expect((await collectionQuality(t, 'o', KB_MAINTENANCE_CALLER))[0]?.availableRerankers).not.toContain('vertex');
    Object.assign(process.env, ON);
    expect((await collectionQuality(t, 'o', KB_MAINTENANCE_CALLER))[0]?.availableRerankers).toContain('vertex');
    await expect(setRetrievalConfig(t, 'o', c.collectionId, 'u', { mode: 'hybrid+rerank', rerank: { kind: 'vertex' } })).resolves.toBeTruthy();
  });

  it('the boot refuses it on with no daily cap', () => {
    expect(() => assertVertexRerankBootConfig({})).not.toThrow();
    expect(() => assertVertexRerankBootConfig({ OPENWOP_KB_VERTEX_RERANK: '1' })).toThrow(/DAILY_CAP/);
    expect(() => assertVertexRerankBootConfig(ON)).not.toThrow();
  });

  it('a search uses Vertex when it answers, and degrades to the local reranker, labelled, when it does not', async () => {
    Object.assign(process.env, ON);
    const t = `t-${n++}`;
    const c = await createCollection(t, 'o', 'u', { name: 'c' });
    await setRetrievalConfig(t, 'o', c.collectionId, 'u', { mode: 'hybrid+rerank', rerank: { kind: 'vertex' } });
    await ingestDocument(t, 'o', 'u', c.collectionId, { title: 'Leave', text: 'Parental leave is sixteen weeks.' }, { documentId: 'leave' });
    await ingestDocument(t, 'o', 'u', c.collectionId, { title: 'Meals', text: 'Meals are reimbursed up to fifty dollars.' }, { documentId: 'meals' });
    __setVertexRerankDepsForTest({ metadata: md(), fetchImpl: fake(200, { records: [{ id: 'meals:0', score: 0.8 }, { id: 'leave:0', score: 0.3 }] }) });
    const ok = await searchDetailed(t, 'o', c.collectionId, 'parental leave', 2, 'hybrid+rerank');
    expect(ok.rerank).toEqual({ requested: 'vertex', applied: 'vertex' });
    expect(ok.hits.map((h) => h.chunkId)).toEqual(['meals:0', 'leave:0']); // Vertex's order wins
    expect(ok.hits[0]!.relevance).toBe(0.8);
    __setVertexRerankDepsForTest({ metadata: md(), fetchImpl: fake(503, {}) });
    const down = await searchDetailed(t, 'o', c.collectionId, 'parental leave', 2, 'hybrid+rerank');
    expect(down.rerank).toEqual({ requested: 'vertex', applied: 'local-degraded' });
    expect(down.hits[0]!.chunkId).toBe('leave:0');
  });
});
