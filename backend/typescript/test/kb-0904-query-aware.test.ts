/**
 * ADR 0904 P1a — query-aware embeddings on the existing BYOK providers (D2) and the
 * vector-cache embed version (architect A1, CRITICAL).
 *
 * Pinned, each sabotage-witnessed (revert → red → restore):
 *  - a search embeds its query AS A QUERY; indexing embeds as documents;
 *  - the Google and Cohere wire bodies carry the task / input type;
 *  - A1: after the Google `q1` change every chunk is re-embedded — the cache's pre-split
 *    vectors (same model, same text hash) are NOT reused, else the rebuild changes nothing;
 *  - OpenAI and Cohere signatures are byte-identical to before (their document side did
 *    not change, so they are not rebuilt); Google gains `:q1`.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollection, ingestDocument, searchDetailed, setRetrievalConfig, collectionQuality, KB_MAINTENANCE_CALLER, CHUNKER_VERSION } from '../src/features/kb/kbService.js';
import { __setHeadlessEmbedderForTest, type HeadlessEmbedder } from '../src/host/headlessAi.js';
import { dispatchEmbeddings } from '../src/providers/dispatch.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../src/aiProviders/localEmbedding.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';

const ORG = 'org-1';
let n = 0;
const tenant = () => `org:kb0904p1a-${Date.now()}-${n++}`;

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kb0904p1a-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(() => { __setHeadlessEmbedderForTest(null); });

interface Call { texts: readonly string[]; inputType: 'query' | 'document' }
function fake(label: Partial<HeadlessEmbedder> & { model: string; provider: string }, calls: Call[] = []): HeadlessEmbedder {
  return {
    ...label,
    embed: async (texts, inputType = 'document') => {
      calls.push({ texts, inputType });
      return texts.map((t) => embedText(`${label.model}:${t}`, DEFAULT_EMBEDDING_DIMS));
    },
  };
}

async function providerCollection(tenantId: string): Promise<string> {
  const c = await createCollection(tenantId, ORG, 'u', { name: 'c' });
  await setRetrievalConfig(tenantId, ORG, c.collectionId, 'u', { embedder: 'provider', mode: 'dense' });
  await ingestDocument(tenantId, ORG, 'u', c.collectionId, { title: 'Leave', text: 'Parental leave is sixteen weeks at full pay for every employee.' });
  await ingestDocument(tenantId, ORG, 'u', c.collectionId, { title: 'Expenses', text: 'Meals are reimbursed up to fifty dollars per day when travelling.' });
  return c.collectionId;
}
const docCount = (calls: Call[]) => calls.filter((c) => c.inputType === 'document').reduce((k, c) => k + c.texts.length, 0);

describe('ADR 0904 D2 — query-aware embeddings', () => {
  it('indexes documents as documents and embeds the search as a query', async () => {
    const calls: Call[] = [];
    __setHeadlessEmbedderForTest(async () => fake({ model: 'text-embedding-3-small', provider: 'openai' }, calls));
    const t = tenant();
    const col = await providerCollection(t);
    await searchDetailed(t, ORG, col, 'parental leave', 3, 'dense');
    expect(docCount(calls)).toBeGreaterThan(0);
    expect(calls.find((c) => c.texts[0] === 'parental leave')?.inputType).toBe('query');
  });

  it('A1 — the Google q1 rebuild re-embeds every chunk instead of reusing pre-split cached vectors', async () => {
    const pre: Call[] = [];
    __setHeadlessEmbedderForTest(async () => fake({ model: 'gemini-embedding-001', provider: 'google' }, pre)); // the pre-0904 shape: no embedVersion
    const t = tenant();
    const col = await providerCollection(t);
    await searchDetailed(t, ORG, col, 'parental leave', 3, 'dense');
    expect(docCount(pre), 'fixture: the pre-split hydrate embedded the chunks').toBeGreaterThan(0);

    const post: Call[] = [];
    __setHeadlessEmbedderForTest(async () => fake({ model: 'gemini-embedding-001', provider: 'google', embedVersion: 'q1' }, post));
    await searchDetailed(t, ORG, col, 'parental leave', 3, 'dense');
    expect(docCount(post), 'every chunk is re-embedded under q1').toBe(docCount(pre));
  });

  it('signatures: Google gains :q1, OpenAI and Cohere are byte-identical to before', async () => {
    for (const [provider, model, sig] of [
      ['google', 'gemini-embedding-001', `provider:gemini-embedding-001:${DEFAULT_EMBEDDING_DIMS}:off:v${CHUNKER_VERSION}:q1`],
      ['openai', 'text-embedding-3-small', `provider:text-embedding-3-small:${DEFAULT_EMBEDDING_DIMS}:off:v${CHUNKER_VERSION}`],
      ['cohere', 'embed-english-v3.0', `provider:embed-english-v3.0:${DEFAULT_EMBEDDING_DIMS}:off:v${CHUNKER_VERSION}`],
    ] as const) {
      __setHeadlessEmbedderForTest(async () => fake({ model, provider, ...(provider === 'google' ? { embedVersion: 'q1' as const } : {}) }));
      const t = tenant();
      const col = await providerCollection(t);
      const q = (await collectionQuality(t, ORG, KB_MAINTENANCE_CALLER)).find((c) => c.collectionId === col)!;
      expect(q.expectedSignature, provider).toBe(sig);
    }
  });

  it('puts the input type on the Google and Cohere wire bodies (OpenAI has none)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      bodies.push(body);
      const reqs = (body.requests as unknown[] | undefined) ?? [];
      const texts = (body.texts as unknown[] | undefined) ?? [];
      const input = (body.input as unknown[] | undefined) ?? [];
      const payload = reqs.length > 0
        ? { embeddings: reqs.map(() => ({ values: [1, 0, 0, 0] })) }
        : input.length > 0 ? { data: input.map((_x, index) => ({ index, embedding: [1, 0, 0, 0] })) }
          : { embeddings: { float: texts.map(() => [1, 0, 0, 0]) } };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    try {
      await dispatchEmbeddings({ provider: 'google', model: 'gemini-embedding-001', apiKey: 'k', texts: ['q'], dimensions: 4, inputType: 'query' });
      await dispatchEmbeddings({ provider: 'google', model: 'gemini-embedding-001', apiKey: 'k', texts: ['d'], dimensions: 4 });
      await dispatchEmbeddings({ provider: 'cohere', model: 'embed-english-v3.0', apiKey: 'k', texts: ['q'], dimensions: 4, inputType: 'query' });
      await dispatchEmbeddings({ provider: 'cohere', model: 'embed-english-v3.0', apiKey: 'k', texts: ['d'], dimensions: 4 });
      await dispatchEmbeddings({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'k', texts: ['q'], dimensions: 4, inputType: 'query' });
    } finally { spy.mockRestore(); }
    const g = (b: Record<string, unknown>) => (b.requests as Array<{ taskType: string }>)[0]!.taskType;
    expect(g(bodies[0]!)).toBe('RETRIEVAL_QUERY');
    expect(g(bodies[1]!)).toBe('RETRIEVAL_DOCUMENT');
    expect(bodies[2]!.input_type).toBe('search_query');
    expect(bodies[3]!.input_type).toBe('search_document');
    expect(Object.keys(bodies[4]!).sort()).toEqual(['dimensions', 'input', 'model']);
  });
});
