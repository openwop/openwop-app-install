/**
 * KBC-3 (ADR 0643 P8) — provider-mode hydrate is BATCHED and BUDGETED.
 *
 * `doHydrate` used to embed EVERY missing chunk in ONE provider call while
 * `drainReindex` batched at 64 (`EMBED_BATCH_CHUNKS`) and was the only embed path
 * that consulted the daily embed budget. So above the provider's per-request
 * ceiling (~2k inputs) every hydrate threw, the catch turned that into a
 * lexical-only degrade, nothing was cached, and the next search did it again:
 * a PERMANENT dense outage for any large collection — and hydrate was the one
 * provider spend a tenant could drive for free, unbudgeted.
 *
 * Pinned, on the injected embedder (the `kb-provider-embeddings.test.ts` seam):
 *   - a collection with ceil(N/64) > 1 batches worth of chunks hydrates in EXACTLY
 *     ceil(N/64) provider calls, each ≤ 64 inputs (sabotage: revert to one call ⇒
 *     red at "calls");
 *   - a budget cap that admits the FIRST batch and refuses the second leaves the
 *     later chunks pending: ONE provider call, the search answers LEXICAL-ONLY with
 *     the honesty label (never a 500, never a partial dense space), and — after the
 *     budget lifts — the next search embeds ONLY the remaining chunks (the first
 *     batch's vectors were cached before the stop);
 *   - the local (deterministic) mode is untouched: no provider call at all.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __setHeadlessEmbedderForTest, type HeadlessEmbedder } from '../src/host/headlessAi.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../src/aiProviders/localEmbedding.js';
import { estimateTokens } from '../src/features/kb/embedBudget.js';
import { chunkText, createCollection, ingestDocument, searchDetailed, setRetrievalConfig } from '../src/features/kb/kbService.js';

const TENANT = `org:kbhyd-${Date.now()}`;
const ORG = 'org-1';
const BATCH = 64; // `EMBED_BATCH_CHUNKS` — module-private in kbService; the number this witness is written against

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbhyd-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(() => { __setHeadlessEmbedderForTest(null); delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY; });

/** A fake provider embedder that records every call's input count. */
function recordingEmbedder(calls: number[][]): HeadlessEmbedder {
  return {
    model: 'fake-embed-batch',
    provider: 'openai',
    embed: async (texts) => {
      calls.push([texts.length]);
      return texts.map((t) => embedText(`shifted:${t}`, DEFAULT_EMBEDDING_DIMS));
    },
  };
}
const chunkCalls = (calls: number[][]): number[] => calls.map((c) => c[0]!).filter((len) => len > 1); // query embeds are 1-input calls

/** A document whose text chunks to at least `wantChunks` chunks — sentence-ish
 *  paragraphs so the deterministic chunker's output is stable. */
function bigText(wantChunks: number): { text: string; chunks: number } {
  const para = (i: number) => `Paragraph ${i}. Grocery fulfilment robots pick items with high accuracy and speed. The FlashPick system handles frozen and chilled goods alike. Operators monitor throughput on a dashboard.`;
  let text = '';
  for (let i = 0; text.length < wantChunks * 1300; i++) text += `${para(i)}\n\n`;
  return { text, chunks: chunkText(text).length };
}

describe('KBC-3 — hydrate embeds in EMBED_BATCH_CHUNKS-sized provider calls', () => {
  it(`a collection with ~3 batches of chunks hydrates in exactly ceil(N/${BATCH}) provider calls, none larger than ${BATCH}`, async () => {
    const calls: number[][] = [];
    __setHeadlessEmbedderForTest(async () => recordingEmbedder(calls));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Batched' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    const { text, chunks } = bigText(2.5 * BATCH);
    expect(chunks, 'non-vacuity: the fixture must span more than two batches').toBeGreaterThan(2 * BATCH);
    expect(chunks).toBeLessThan(1000);
    // Provider mode defers vectorization to the first search — the hydrate under test.
    const d = await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Big', text });
    expect(d.chunkCount).toBe(chunks);

    const { hits, embedding } = await searchDetailed(TENANT, ORG, col.collectionId, 'frozen goods throughput', 5);
    expect(embedding.mode).toBe('provider');
    expect(hits.length).toBeGreaterThan(0);
    const batches = chunkCalls(calls);
    expect(batches.length, `expected ceil(${chunks}/${BATCH}) provider calls, saw ${JSON.stringify(batches)}`).toBe(Math.ceil(chunks / BATCH));
    expect(Math.max(...batches)).toBeLessThanOrEqual(BATCH);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(chunks);

    // Second search: everything is cached — no chunk embeds at all.
    const before = chunkCalls(calls).length;
    await searchDetailed(TENANT, ORG, col.collectionId, 'operators dashboard', 5);
    expect(chunkCalls(calls).length).toBe(before);
  });

  it('a budget cap hit MID-hydrate leaves the later chunks pending: 1 call, lexical-only (labeled), and the next search embeds only the remainder', async () => {
    const calls: number[][] = [];
    __setHeadlessEmbedderForTest(async () => recordingEmbedder(calls));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Budgeted' });
    await setRetrievalConfig(TENANT, ORG, col.collectionId, 'u1', { embedder: 'provider' });
    const { text, chunks } = bigText(2.5 * BATCH);
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Big', text });
    // A cap that admits the FIRST batch and refuses the second: the first batch's
    // tokens plus a margin smaller than any second batch.
    const pieces = chunkText(text);
    const firstBatchTokens = pieces.slice(0, BATCH).reduce((n, t) => n + estimateTokens(t), 0);
    process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = String(firstBatchTokens + 8);

    const degraded = await searchDetailed(TENANT, ORG, col.collectionId, 'frozen goods throughput', 5);
    expect(chunkCalls(calls), 'exactly ONE batch went to the provider before the budget refused the second').toEqual([BATCH]);
    expect(degraded.embedding.mode, 'a partial dense space is never served — the search degrades honestly').toBe('lexical-only');
    expect(degraded.hits.length, 'and it still ANSWERS, from the lexical channel').toBeGreaterThan(0);

    // Budget lifts (rollover): the next search embeds ONLY what is still missing.
    delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
    const healed = await searchDetailed(TENANT, ORG, col.collectionId, 'frozen goods throughput', 5);
    expect(healed.embedding.mode).toBe('provider');
    const all = chunkCalls(calls);
    expect(all.reduce((a, b) => a + b, 0), 'the first batch was cached before the stop — it is never re-billed').toBe(chunks);
    expect(all.length).toBe(Math.ceil(chunks / BATCH));
  });

  it('local mode makes NO provider call (the deterministic embedder is the floor)', async () => {
    const calls: number[][] = [];
    __setHeadlessEmbedderForTest(async () => recordingEmbedder(calls));
    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Local' });
    const { text } = bigText(1.5 * BATCH);
    await ingestDocument(TENANT, ORG, 'u1', col.collectionId, { title: 'Big', text });
    const { embedding } = await searchDetailed(TENANT, ORG, col.collectionId, 'frozen goods', 3);
    expect(embedding.mode).toBe('local');
    expect(calls).toEqual([]);
  });
});
