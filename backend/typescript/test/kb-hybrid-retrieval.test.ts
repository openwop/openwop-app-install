/**
 * ADR 0113 Phase 1 — hybrid (BM25 + dense) retrieval via RRF.
 * Pure BM25/RRF correctness + determinism, plus an integration proof that
 * `mode:'hybrid'` surfaces an exact-term chunk and preserves content-trust.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { bm25Search, rrfFuse, tokenize } from '../src/features/kb/lexicalIndex.js';
import { localRerank, localRerankScore } from '../src/features/kb/reranker.js';
import { createCollection, ingestDocument, search } from '../src/features/kb/kbService.js';

describe('BM25 lexical channel', () => {
  const docs = [
    { id: 'a', text: 'the quarterly revenue forecast looks strong' },
    { id: 'b', text: 'invoice INV-9981 is overdue and unpaid' },
    { id: 'c', text: 'general chatter about the weather today' },
  ];

  it('tokenizes lowercase alphanumerics', () => {
    expect(tokenize('Invoice INV-9981!')).toEqual(['invoice', 'inv', '9981']);
  });

  it('recalls an exact rare token (the dense-hash blind spot)', () => {
    const hits = bm25Search(docs, '9981', 5);
    expect(hits[0]!.id).toBe('b');
  });

  it('is deterministic — identical input yields identical order', () => {
    const a = bm25Search(docs, 'revenue forecast', 5);
    const b = bm25Search(docs, 'revenue forecast', 5);
    expect(a).toEqual(b);
  });

  it('returns [] for an empty query or empty corpus', () => {
    expect(bm25Search(docs, '   ', 5)).toEqual([]);
    expect(bm25Search([], 'x', 5)).toEqual([]);
  });
});

describe('Reciprocal-Rank-Fusion', () => {
  it('fuses two ranked lists, rewarding agreement', () => {
    const dense = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const lexical = [{ id: 'y' }, { id: 'x' }, { id: 'w' }];
    const fused = rrfFuse([dense, lexical], 60);
    // x (ranks 0,1) and y (ranks 1,0) both appear in both lists → top two.
    expect(new Set([fused[0]!.id, fused[1]!.id])).toEqual(new Set(['x', 'y']));
    expect(fused.some((f) => f.id === 'w')).toBe(true);
  });

  it('is deterministic with a stable id tiebreak', () => {
    const l = [{ id: 'b' }, { id: 'a' }];
    expect(rrfFuse([l], 60)).toEqual(rrfFuse([l], 60));
  });
});

describe('local reranker', () => {
  it('scores full query coverage above partial', () => {
    const full = localRerankScore('migration runbook plan', 'the migration runbook plan in full', 'X');
    const partial = localRerankScore('migration runbook plan', 'the migration plan only', 'X');
    expect(full).toBeGreaterThan(partial);
  });
  it('rewards an exact-phrase + title match', () => {
    const phrase = localRerankScore('annual budget', 'the annual budget report', 'Annual budget');
    const scattered = localRerankScore('annual budget', 'budget items, reviewed annually', 'Misc');
    expect(phrase).toBeGreaterThan(scattered);
  });
  it('is deterministic', () => {
    const cands = [{ id: 'b', text: 'beta plan', title: '' }, { id: 'a', text: 'alpha plan', title: '' }];
    expect(localRerank('plan', cands, 5)).toEqual(localRerank('plan', cands, 5));
  });
});

describe('kbService hybrid search', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbhybrid-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('mode:hybrid surfaces an exact-term chunk + preserves content-trust + is deterministic', async () => {
    const tenantId = 'kbh-tenant';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Finance', text: 'The annual budget summary and revenue plan.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Tickets', text: 'Reference ZX-4471 covers the migration runbook.' });

    // An exact identifier the local-hash dense channel has no lexical signal for.
    const hybrid = await search(tenantId, orgId, col.collectionId, 'ZX-4471', 5, 'hybrid');
    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid[0]!.title).toBe('Tickets');
    expect(hybrid[0]!.contentTrust).toBe('trusted');

    // Deterministic ⇒ replay-safe (the ADR 0113 invariant).
    const again = await search(tenantId, orgId, col.collectionId, 'ZX-4471', 5, 'hybrid');
    expect(again.map((h) => h.chunkId)).toEqual(hybrid.map((h) => h.chunkId));
  });

  it('mode:hybrid+rerank reorders deterministically + preserves trust', async () => {
    const tenantId = 'kbh-rerank';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Partial', text: 'The migration plan mentions runbook steps.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Full', text: 'The database migration runbook plan covers every step in detail.' });

    const hits = await search(tenantId, orgId, col.collectionId, 'migration runbook plan', 5, 'hybrid+rerank');
    expect(hits.length).toBeGreaterThan(0);
    // 'Full' covers all three query terms → reranks first.
    expect(hits[0]!.title).toBe('Full');
    expect(hits[0]!.contentTrust).toBe('trusted');
    const again = await search(tenantId, orgId, col.collectionId, 'migration runbook plan', 5, 'hybrid+rerank');
    expect(again.map((h) => h.chunkId)).toEqual(hits.map((h) => h.chunkId)); // deterministic
  });

  it('mode:dense remains the unchanged default', async () => {
    const tenantId = 'kbh-tenant2';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Cats', text: 'Cats groom and purr softly.' });
    const dense = await search(tenantId, orgId, col.collectionId, 'cats groom', 5);
    expect(dense.length).toBeGreaterThan(0);
    expect(dense[0]!.title).toBe('Cats');
  });
});
