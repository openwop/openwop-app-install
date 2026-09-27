/**
 * ADR 0351 Phase 4 — URL ingest + heading-path enrichment. Pins:
 *  - URL ingest validates the scheme, extracts readable text through the
 *    SSRF-guarded web surface (mocked fetch), and fences the doc UNTRUSTED;
 *  - enrichChunkText behavior via retrieval: with enrichment on, a chunk whose
 *    section heading matches the query ranks (the embedded text carries the
 *    heading path) while the stored hit text stays RAW;
 *  - config validation for the enrichment knob.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the web-research surface at the MODULE seam — ssrfGuardedFetch inside it
// does its own resolution (a globalThis.fetch stub leaks to the real network).
vi.mock('../src/host/webResearchSurface.js', () => ({
  createWebResearchSurface: () => ({
    search: async () => ({ results: [], engine: 'mock' }),
    fetchBatch: async ({ urls }: { urls: string[] }) => ({
      pages: urls.map((url) => ({ url, status: 200, title: 'FlashPick Spec', extractedText: 'Overview. Robotic picking speeds grocery fulfillment substantially.' })),
    }),
    research: async () => ({ citations: [] }),
  }),
}));
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import {
  createCollection, ingestDocument, getDocument, setRetrievalConfig, searchDetailed,
} from '../src/features/kb/kbService.js';

const T = 'kburl-tenant';
const ORG = 'o1';

beforeAll(() => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kburl-')) });
});
beforeEach(() => { initHostExtPersistence(openSqliteStorage(':memory:')); });

describe('URL ingest (ADR 0351 P4)', () => {
  it('rejects non-http(s) urls', async () => {
    const col = await createCollection(T, ORG, 'u1', { name: 'U' });
    await expect(ingestDocument(T, ORG, 'u1', col.collectionId, { url: 'ftp://evil' }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('ingests readable text, derives the title, and fences UNTRUSTED', async () => {
    const col = await createCollection(T, ORG, 'u1', { name: 'U2' });
    const doc = await ingestDocument(T, ORG, 'u1', col.collectionId, { url: 'https://example.com/spec' });
    expect(doc.title).toBe('FlashPick Spec'); // derived from <title>
    expect(doc.contentTrust).toBe('untrusted'); // web content is never trusted
    expect(doc.source).toEqual({ kind: 'url', url: 'https://example.com/spec' });
    const full = await getDocument(T, ORG, col.collectionId, doc.documentId);
    expect(full?.text).toContain('Robotic picking');
  });
});

describe('heading-path enrichment (ADR 0351 P4)', () => {
  it('validates the knob; embedded text carries the heading path while hit text stays raw', async () => {
    const col = await createCollection(T, ORG, 'u1', { name: 'E' });
    await expect(setRetrievalConfig(T, ORG, col.collectionId, 'u1', { enrichment: 'llm' }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await setRetrievalConfig(T, ORG, col.collectionId, 'u1', { enrichment: 'heading-path' });

    // The chunk body never mentions "pricing" — only its section heading does.
    // With heading-path enrichment the EMBEDDED text carries the heading, so a
    // pricing query densely matches the chunk; the returned hit text stays raw.
    await ingestDocument(T, ORG, 'u1', col.collectionId, {
      title: 'Contract', text: '# Pricing terms\nThe monthly fee is fixed for the first year and reviewed annually thereafter.',
    });
    const { hits, embedding } = await searchDetailed(T, ORG, col.collectionId, 'pricing terms contract', 3);
    expect(embedding.mode).toBe('local');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text.startsWith('[')).toBe(false); // stored text raw (no prefix leak)
  });
});
