/**
 * ADR 0351 Phase 1 — provider embeddings for KB retrieval. Pins:
 *  - the embedder config knob (validation + storage on retrievalConfig);
 *  - HONEST degrade: provider mode with no resolvable embedder ⇒ lexical-only
 *    (labeled), never a silent local-hash fallback into a provider namespace;
 *  - the provider path via the test seam: chunks embedded ONCE into the durable
 *    vec cache (second hydrate = no re-embed), query embedded per search;
 *  - signature switch (local → provider) wipes + rebuilds the namespace;
 *  - dispatchEmbeddings request/response shapes (mocked fetch).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  createCollection, ingestDocument, upsertDocument, deleteDocument, setRetrievalConfig, searchDetailed, ragQuery, chunkText,
} from '../src/features/kb/kbService.js';
import { __setHeadlessEmbedderForTest, type HeadlessEmbedder } from '../src/host/headlessAi.js';
import { dispatchEmbeddings } from '../src/providers/dispatch.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../src/aiProviders/localEmbedding.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT = `org:kbemb-${Date.now()}`;
const ORG = 'org-1';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbemb-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(() => { __setHeadlessEmbedderForTest(null); });

/** A fake provider embedder that counts calls and returns shifted local-hash
 *  vectors (deterministic, but distinct from the local model's output). */
function fakeEmbedder(counter: { chunks: number; queries: number }): HeadlessEmbedder {
  return {
    model: 'fake-embed-1',
    provider: 'openai',
    embed: async (texts) => {
      if (texts.length === 1) counter.queries += 1; else counter.chunks += texts.length;
      return texts.map((t) => embedText(`shifted:${t}`, DEFAULT_EMBEDDING_DIMS));
    },
  };
}

describe('ADR 0351 P1 — embedder config', () => {
  it('validates + stores the embedder knob', async () => {
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Cfg' });
    await expect(setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'nope' }))
      .rejects.toMatchObject({ httpStatus: 400 });
    const updated = await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider', mode: 'hybrid' });
    expect(updated.retrievalConfig?.embedder).toBe('provider');
    expect(updated.retrievalConfig?.mode).toBe('hybrid');
  });
});

describe('ADR 0351 P1 — honest lexical-only degrade', () => {
  it('provider mode with NO embedder serves BM25 hits labeled lexical-only', async () => {
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'NoProvider' });
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Robots', text: 'FlashPick robotic picking automates grocery fulfillment with high accuracy.' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    // No test-seam override and no BYOK default in this test tenant ⇒ resolver → null.
    const { hits, embedding } = await searchDetailed(TENANT, ORG, col.collectionId, 'robotic picking', 5);
    expect(embedding.mode).toBe('lexical-only');
    expect(hits.length).toBeGreaterThan(0); // BM25 still finds it
    expect(hits[0]!.text).toContain('robotic picking');
    // The rag surface carries the same label (honesty rides the artifact shape).
    const rag = await ragQuery(TENANT, ORG, col.collectionId, 'robotic picking', 5);
    expect(rag.embedding.mode).toBe('lexical-only');
    expect(rag.contexts.length).toBeGreaterThan(0);
  });
});

describe('ADR 0351 P1 — provider path via the seam', () => {
  it('embeds chunks once (durable cache), queries per search, and wipes on signature switch', async () => {
    const counter = { chunks: 0, queries: 0 };
    __setHeadlessEmbedderForTest(async () => fakeEmbedder(counter));

    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Provider' });
    // Ingest under LOCAL first — exercises the local→provider signature wipe.
    // Long enough to produce MULTIPLE chunks (>1200 chars), so the hydrate batch
    // is distinguishable from a single-text query embed in the fake's counter.
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: warehouse automation reduces picking errors and speeds fulfillment for grocery operators across the network.`).join(' ');
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Doc', text: longText });
    const local = await searchDetailed(TENANT, ORG, col.collectionId, 'picking errors', 5);
    expect(local.embedding.mode).toBe('local');
    expect(local.hits.length).toBeGreaterThan(0);

    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    const first = await searchDetailed(TENANT, ORG, col.collectionId, 'picking errors', 5);
    expect(first.embedding).toEqual({ mode: 'provider', model: 'fake-embed-1' });
    expect(first.hits.length).toBeGreaterThan(0); // dense over provider vectors
    const chunksAfterFirst = counter.chunks;
    expect(chunksAfterFirst).toBeGreaterThan(0);
    expect(counter.queries).toBe(1);

    // Second search: cache serves the chunk vectors — ONLY the query embeds.
    const second = await searchDetailed(TENANT, ORG, col.collectionId, 'fulfillment speed', 5);
    expect(second.embedding.mode).toBe('provider');
    expect(counter.chunks).toBe(chunksAfterFirst);
    expect(counter.queries).toBe(2);
  });

  it('chunk-embed failure at HYDRATE degrades the search to labeled lexical-only, then recovers (KB-CODE-3)', async () => {
    let fail = true;
    const counter = { chunks: 0, queries: 0 };
    const inner = fakeEmbedder(counter);
    __setHeadlessEmbedderForTest(async () => ({
      ...inner,
      // Throw on the multi-text CHUNK batch (hydrate); single-text query embeds succeed.
      embed: async (texts) => { if (fail && texts.length > 1) throw new Error('provider down at hydrate'); return inner.embed(texts); },
    }));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'HydrateFail' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: robotic picking reduces errors and speeds grocery fulfillment across warehouses.`).join(' ');
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Doc', text: longText });

    // The hydrate embed throws — the search must NOT 500: labeled lexical-only.
    const degraded = await searchDetailed(TENANT, ORG, col.collectionId, 'robotic picking', 5);
    expect(degraded.embedding.mode).toBe('lexical-only');
    expect(degraded.hits.length).toBeGreaterThan(0); // BM25 still serves

    // Not marked hydrated on failure — the next search retries and recovers.
    fail = false;
    const recovered = await searchDetailed(TENANT, ORG, col.collectionId, 'robotic picking', 5);
    expect(recovered.embedding).toEqual({ mode: 'provider', model: 'fake-embed-1' });
    expect(recovered.hits.length).toBeGreaterThan(0);
  });

  it('concurrent cold searches share ONE hydrate — the chunk set embeds exactly once (KB-CODE-5)', async () => {
    const counter = { chunks: 0, queries: 0 };
    __setHeadlessEmbedderForTest(async () => fakeEmbedder(counter));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Concurrent' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: cold chain telemetry keeps produce fresh across the grocery network every day.`).join(' ');
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Doc', text: longText });

    const [a, b] = await Promise.all([
      searchDetailed(TENANT, ORG, col.collectionId, 'cold chain telemetry', 5),
      searchDetailed(TENANT, ORG, col.collectionId, 'produce freshness', 5),
    ]);
    expect(a.embedding.mode).toBe('provider');
    expect(b.embedding.mode).toBe('provider');
    expect(counter.chunks).toBe(chunkText(longText).length); // ONE hydrate, not two
    expect(counter.queries).toBe(2); // each search still embeds its own query
  });

  it('stable-id upsert preserves the chunk cache — only changed chunks re-embed (KB-CODE-9)', async () => {
    const batches: number[] = [];
    __setHeadlessEmbedderForTest(async () => ({
      model: 'fake-embed-1',
      provider: 'openai',
      embed: async (texts) => { batches.push(texts.length); return texts.map((t) => embedText(`shifted:${t}`, DEFAULT_EMBEDDING_DIMS)); },
    }));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'UpsertCache' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: warehouse robots stage totes for pickers and cut travel time dramatically today.`).join(' ');
    await upsertDocument(TENANT, ORG, col.collectionId, 'doc-u', 'u1', { title: 'Doc', text: longText });
    await searchDetailed(TENANT, ORG, col.collectionId, 'warehouse robots', 5);
    const fullChunks = chunkText(longText).length;
    expect(batches[0]).toBe(fullChunks); // first hydrate embeds everything

    // Append a tail — only the trailing chunk(s) change; the leading chunks'
    // hashes still match the (preserved) cache, so they must NOT re-embed.
    const updated = `${longText} Appended: a new paragraph about robot maintenance schedules.`;
    await upsertDocument(TENANT, ORG, col.collectionId, 'doc-u', 'u1', { title: 'Doc', text: updated });
    await searchDetailed(TENANT, ORG, col.collectionId, 'warehouse robots', 5);
    const rehydrateBatch = batches[2]!; // [full hydrate, query, re-hydrate misses, query]
    expect(rehydrateBatch).toBeGreaterThanOrEqual(1);
    expect(rehydrateBatch).toBeLessThan(fullChunks); // NOT a full re-embed (cache preserved)
  });

  it('the chunk cache is tenant-scoped — one tenant\'s delete never purges another\'s rows (KB-CODE-4 / CS-DATA-6)', async () => {
    const counter = { chunks: 0, queries: 0 };
    __setHeadlessEmbedderForTest(async () => fakeEmbedder(counter));
    const T2 = `${TENANT}-b`;
    const colA = await createCollection(TENANT, ORG, 'u1', { name: 'TenantA' });
    const colB = await createCollection(T2, ORG, 'u1', { name: 'TenantB' });
    await setRetrievalConfig(TENANT, ORG, colA.collectionId, 'u1', { embedder: 'provider' });
    await setRetrievalConfig(T2, ORG, colB.collectionId, 'u1', { embedder: 'provider' });
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: freight scheduling balances dock capacity against carrier arrival windows smoothly.`).join(' ');
    // The SAME caller-supplied documentId in both tenants (documentId is not globally unique).
    await upsertDocument(TENANT, ORG, colA.collectionId, 'shared-doc', 'u1', { title: 'Doc', text: longText });
    await upsertDocument(T2, ORG, colB.collectionId, 'shared-doc', 'u1', { title: 'Doc', text: longText });
    await searchDetailed(TENANT, ORG, colA.collectionId, 'freight scheduling', 5);
    await searchDetailed(T2, ORG, colB.collectionId, 'freight scheduling', 5);
    const chunksAfterBoth = counter.chunks;

    // Tenant A deletes its doc (purges A's cache rows) …
    await deleteDocument(TENANT, ORG, colA.collectionId, 'shared-doc');
    // … tenant B ingests another doc (drops B's hydrated marker) and re-hydrates:
    // doc-1's vectors MUST come from B's still-intact cache — only doc-2 embeds.
    const secondText = Array.from({ length: 30 }, (_, i) => `Sentence ${i}: dock doors assign trailers by arrival slot and unload priority for the day.`).join(' ');
    await ingestDocument(T2, ORG, 'u1', colB.collectionId, { title: 'Doc2', text: secondText });
    await searchDetailed(T2, ORG, colB.collectionId, 'dock doors', 5);
    expect(counter.chunks - chunksAfterBoth).toBe(chunkText(secondText).length);
  });

  it('query-time provider failure degrades THAT search to labeled lexical-only', async () => {
    let fail = false;
    const counter = { chunks: 0, queries: 0 };
    const flaky = fakeEmbedder(counter);
    __setHeadlessEmbedderForTest(async () => ({
      ...flaky,
      embed: async (texts) => { if (fail && texts.length === 1) throw new Error('provider down'); return flaky.embed(texts); },
    }));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Flaky' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Doc', text: 'Cold chain logistics keep produce fresh across the grocery network.' });
    const ok = await searchDetailed(TENANT, ORG, col.collectionId, 'cold chain', 5);
    expect(ok.embedding.mode).toBe('provider');
    fail = true;
    const degraded = await searchDetailed(TENANT, ORG, col.collectionId, 'cold chain', 5);
    expect(degraded.embedding.mode).toBe('lexical-only');
    expect(degraded.hits.length).toBeGreaterThan(0);
  });
});

describe('ADR 0351 P1 — dispatchEmbeddings shapes (mocked fetch)', () => {
  it('openai: POST /v1/embeddings with dimensions; sorts by index; normalizes', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [
        { index: 1, embedding: [0, 3] },
        { index: 0, embedding: [4, 0] },
      ] }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const r = await dispatchEmbeddings({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'k', texts: ['a', 'b'], dimensions: 2 });
      expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
      expect(calls[0]!.body).toMatchObject({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 2 });
      expect(r.vectors).toEqual([[1, 0], [0, 1]]); // index-sorted + L2-normalized
    } finally { vi.unstubAllGlobals(); }
  });

  it('google: batchEmbedContents with outputDimensionality', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ embeddings: [{ values: [0, 2] }] }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const r = await dispatchEmbeddings({ provider: 'google', model: 'gemini-embedding-001', apiKey: 'k', texts: ['x'], dimensions: 2 });
      expect(calls[0]!.url).toContain(':batchEmbedContents');
      expect((calls[0]!.body.requests as Array<Record<string, unknown>>)[0]).toMatchObject({ outputDimensionality: 2 });
      expect(r.vectors).toEqual([[0, 1]]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('providers without an embeddings API are refused honestly', async () => {
    await expect(dispatchEmbeddings({ provider: 'anthropic', model: 'x', apiKey: 'k', texts: ['a'], dimensions: 2 }))
      .rejects.toThrow(/embeddings_unsupported_provider/);
  });
});
