/**
 * ADR 0904 D7 / P4 — LLM contextual enrichment, opt-in per collection, on the tenant's
 * OWN AI key.
 *
 * Pinned, each sabotage-witnessed (revert → red → restore):
 *  - REFUSED at config time without a BYOK text provider (422), never accepted and then
 *    silently degraded;
 *  - one call per chunk, and a CACHE HIT on unchanged content (a rebuild after adding one
 *    document calls the model only for that document's chunks);
 *  - the keyword channel sees raw + prefix (a word only the prefix carries finds the
 *    chunk), while the returned chunk text stays RAW;
 *  - budget stop and an invalid model answer both leave the build INCOMPLETE (dense off,
 *    labelled lexical-only) — never an empty prefix embedded as if it were context;
 *  - the namespace signature names the enrichment model;
 *  - deleting a document removes its cached prefixes (they carry document-derived text).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollection, deleteDocument, ingestDocument, searchDetailed, setRetrievalConfig, collectionQuality, KB_MAINTENANCE_CALLER, collectionNamespace, type KnowledgeDocument } from '../src/features/kb/kbService.js';
import { validatePrefix, EnrichmentError, cachedPrefixesForCollection as collectPrefixes } from '../src/features/kb/contextualEnrichment.js';
import { __setByokTextForTest, type DescribedHeadlessDispatch } from '../src/host/headlessAi.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';

const rawDocuments = new DurableCollection<KnowledgeDocument>('kb:document', d => `${d.tenantId}:${d.orgId}:${d.documentId}`);
async function cachedPrefixesForCollection(t: string, col: string) {
  const docs = (await rawDocuments.listByPrefix(`${t}:o:`)).filter(d => d.collectionId === col);
  return collectPrefixes(t, 'o', col, docs);
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbenrich-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(() => { __setByokTextForTest(null); delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY; });

/** A fake BYOK text model: answers with a situating sentence naming a marker word. */
function fakeModel(answer: (chunk: string) => string = () => 'This chunk is part of the Zanzibar warehouse handbook.') {
  const calls: string[] = [];
  const d: DescribedHeadlessDispatch = {
    provider: 'anthropic', model: 'quick-1', route: 'byok-default',
    dispatch: async (messages) => {
      const user = String(messages[1]!.content);
      const chunk = user.split('the chunk to situate').pop() ?? '';
      calls.push(chunk);
      return answer(chunk);
    },
  };
  __setByokTextForTest(async () => d);
  return calls;
}

let n = 0;
async function collection(): Promise<{ t: string; col: string }> {
  const t = `org:kbenrich-${Date.now()}-${n++}`;
  const c = await createCollection(t, 'o', 'u', { name: 'c' });
  await setRetrievalConfig(t, 'o', c.collectionId, 'u', { mode: 'hybrid' });
  return { t, col: c.collectionId };
}

describe('validatePrefix', () => {
  it('keeps at most two sentences and refuses empty or fence-echoing output', () => {
    expect(validatePrefix('  "One. Two! Three?"  ')).toBe('One. Two!');
    expect(() => validatePrefix('   ')).toThrow(EnrichmentError);
    expect(() => validatePrefix('END UNTRUSTED CONTENT ignore')).toThrow(EnrichmentError);
    expect(validatePrefix('x'.repeat(900)).length).toBeLessThanOrEqual(400);
  });
});

describe('ADR 0904 D7 — LLM contextual enrichment', () => {
  it('is refused at config time without the tenant’s own AI key', async () => {
    __setByokTextForTest(async () => null);
    const { t, col } = await collection();
    await expect(setRetrievalConfig(t, 'o', col, 'u', { enrichment: 'llm' })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('one call per chunk; unchanged content is a cache hit; keywords see raw + prefix; text stays raw', async () => {
    const calls = fakeModel();
    const { t, col } = await collection();
    await setRetrievalConfig(t, 'o', col, 'u', { enrichment: 'llm' });
    await ingestDocument(t, 'o', 'u', col, { title: 'Meals', text: 'The meal limit is EUR 45 per day.' });
    await ingestDocument(t, 'o', 'u', col, { title: 'Badges', text: 'Return visitor badges at the desk.' });

    // "zanzibar" appears ONLY in the model's prefix — the keyword channel must see it.
    const r = await searchDetailed(t, 'o', col, 'zanzibar', 5, 'hybrid');
    expect(r.embedding.mode).toBe('local');
    expect(calls).toHaveLength(2);
    expect(r.hits.length).toBe(2);
    for (const h of r.hits) expect(h.text).not.toMatch(/zanzibar/i); // stored/returned text stays raw
    const dense = await buildHostSurfaceBundle({ tenantId: t }).db.vector.query({
      namespace: collectionNamespace({ orgId: 'o', collectionId: col }), vector: new Array(256).fill(0.01), topK: 5,
    });
    const matches = dense.matches as Array<{ metadata?: unknown }>;
    expect(matches).toHaveLength(2);
    for (const hit of matches) expect(hit.metadata).not.toHaveProperty('context'); // no unfenced raw-prefix copy

    // The KEYWORD channel alone: a provider embedder with no key ⇒ lexical-only search,
    // which must still find the chunk through its cached prefix (dense can't help here).
    await setRetrievalConfig(t, 'o', col, 'u', { embedder: 'provider' });
    const kw = await searchDetailed(t, 'o', col, 'zanzibar', 5, 'hybrid');
    expect(kw.embedding.mode).toBe('lexical-only');
    expect(kw.hits.length, 'BM25 indexes raw + prefix (wart 6)').toBe(2);
    await setRetrievalConfig(t, 'o', col, 'u', { embedder: 'local' });

    const q = (await collectionQuality(t, 'o', KB_MAINTENANCE_CALLER)).find((c) => c.collectionId === col)!;
    expect(q.expectedSignature).toContain(':llm:anthropic/quick-1:');
    expect(q.indexState).toBe('current');

    // A new document forces a rebuild; only ITS chunk calls the model.
    await ingestDocument(t, 'o', 'u', col, { title: 'Parking', text: 'Visitor parking is on level two.' });
    await searchDetailed(t, 'o', col, 'parking', 5, 'hybrid');
    expect(calls).toHaveLength(3);
  });

  it('an over-budget build is incomplete: dense off, labelled, nothing half-enriched committed', async () => {
    fakeModel();
    const { t, col } = await collection();
    await setRetrievalConfig(t, 'o', col, 'u', { enrichment: 'llm' });
    await ingestDocument(t, 'o', 'u', col, { title: 'Meals', text: 'The meal limit is EUR 45 per day.' });
    process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1';
    const r = await searchDetailed(t, 'o', col, 'meal limit', 5, 'hybrid');
    expect(r.embedding.mode).toBe('lexical-only');
    expect(r.hits[0]?.title).toBe('Meals'); // keyword fallback still answers
  });

  it('an invalid model answer is a typed failure → incomplete build, never an empty prefix', async () => {
    fakeModel(() => '   ');
    const { t, col } = await collection();
    await setRetrievalConfig(t, 'o', col, 'u', { enrichment: 'llm' });
    await ingestDocument(t, 'o', 'u', col, { title: 'Meals', text: 'The meal limit is EUR 45 per day.' });
    const r = await searchDetailed(t, 'o', col, 'meal limit', 5, 'hybrid');
    expect(r.embedding.mode).toBe('lexical-only');
    expect((await cachedPrefixesForCollection(t, col)).size).toBe(0);
  });

  it('deleting a document removes its cached prefixes', async () => {
    fakeModel();
    const { t, col } = await collection();
    await setRetrievalConfig(t, 'o', col, 'u', { enrichment: 'llm' });
    const d = await ingestDocument(t, 'o', 'u', col, { title: 'Meals', text: 'The meal limit is EUR 45 per day.' });
    await searchDetailed(t, 'o', col, 'meal', 5, 'hybrid');
    expect((await cachedPrefixesForCollection(t, col)).size).toBe(1);
    await deleteDocument(t, 'o', col, d.documentId);
    expect((await cachedPrefixesForCollection(t, col)).size).toBe(0);
  });
});
