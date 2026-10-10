/**
 * ADR 0113 Phase 1 — hybrid (BM25 + dense) retrieval via RRF.
 * Pure BM25/RRF correctness + determinism, plus an integration proof that
 * `mode:'hybrid'` surfaces an exact-term chunk and preserves content-trust.
 *
 * DETERMINISM is asserted as its MECHANISM — ties resolve by ascending id whatever
 * the input order — not by calling a pure function twice (a JS sort is stable, so
 * that comparison could not fail; wave-6 /grade-tests measured all three such cases
 * green with the tiebreak reversed). Each reranker feature (coverage, phrase, title)
 * is pinned with the other features held equal. Sabotage: reverse a tiebreak ⇒ its
 * determinism case red; drop the lexical channel from the fusion ⇒ the exact-term
 * case red; default `search` to hybrid ⇒ the dense-default case red.
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

  it('is deterministic — identical input yields identical order (ties resolve by ascending id)', () => {
    const tie = [{ id: 'z', text: 'alpha note' }, { id: 'a', text: 'alpha note' }];
    expect(bm25Search(tie, 'alpha', 5).map((h) => h.id)).toEqual(['a', 'z']);
    expect(bm25Search([...tie].reverse(), 'alpha', 5).map((h) => h.id)).toEqual(['a', 'z']);
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
    // b and a score 1/61 each (rank 0 in one list) — a tie the id must break.
    expect(rrfFuse([[{ id: 'b' }], [{ id: 'a' }]], 60).map((f) => f.id)).toEqual(['a', 'b']);
    expect(rrfFuse([[{ id: 'a' }], [{ id: 'b' }]], 60).map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('local reranker', () => {
  it('scores full query coverage above partial', () => {
    // Neither text holds the query as a phrase and the titles are equal, so only
    // coverage (and the density tiebreak, which favours the SHORTER partial) differs.
    const full = localRerankScore('migration runbook plan', 'plan then runbook then migration', 'X');
    const partial = localRerankScore('migration runbook plan', 'plan then migration', 'X');
    expect(full).toBeGreaterThan(partial);
  });
  it('rewards an exact-phrase + title match', () => {
    // Phrase: identical token sets and titles; only the word ORDER differs.
    const inOrder = localRerankScore('annual budget', 'annual budget review', 'Misc');
    const scrambled = localRerankScore('annual budget', 'budget review annual', 'Misc');
    expect(inOrder).toBeGreaterThan(scrambled);
    // Title: identical text; only the title differs.
    const titled = localRerankScore('annual budget', 'budget review annual', 'Annual budget');
    expect(titled).toBeGreaterThan(scrambled);
  });
  it('is deterministic', () => {
    // Equal scores (same coverage, density, no phrase, no title) — the id breaks the tie.
    const cands = [{ id: 'b', text: 'beta plan', title: '' }, { id: 'a', text: 'alpha plan', title: '' }];
    expect(localRerank('plan', cands, 5).map((r) => r.id)).toEqual(['a', 'b']);
    expect(localRerank('plan', [...cands].reverse(), 5).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('kbService hybrid search', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbhybrid-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  /** A file upload is fenced untrusted at ingest (ADR 0108) — the honest way to seed one. */
  const untrustedUpload = (title: string, text: string) => ({ title, contentBase64: Buffer.from(text, 'utf8').toString('base64'), contentType: 'text/plain' });

  it('mode:hybrid surfaces an exact-term chunk + preserves content-trust + is deterministic', async () => {
    const tenantId = 'kbh-tenant';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Finance', text: 'The annual budget summary and revenue plan for the annual budget review.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Budget notes', text: 'Budget notes: the annual budget is approved.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, untrustedUpload('Tickets', 'Reference ZX-4471 covers the migration runbook.'));

    // Precondition: the local-hash dense channel ranks the exact-identifier chunk out
    // of the top 2 — so only the lexical (BM25) channel can bring it back.
    const q = '4471 budget';
    const dense = await search(tenantId, orgId, col.collectionId, q, 2, 'dense');
    expect(dense.map((h) => h.title), 'fixture precondition: dense misses the identifier').not.toContain('Tickets');

    const hybrid = await search(tenantId, orgId, col.collectionId, q, 2, 'hybrid');
    const ticket = hybrid.find((h) => h.title === 'Tickets');
    expect(ticket, 'hybrid must surface the exact-term chunk dense missed').toBeDefined();
    expect(ticket!.contentTrust, 'the lexical-only hit keeps its trust label').toBe('untrusted');
    expect(hybrid.find((h) => h.title !== 'Tickets')!.contentTrust).toBe('trusted');

    // Deterministic ⇒ replay-safe (the ADR 0113 invariant).
    const again = await search(tenantId, orgId, col.collectionId, q, 2, 'hybrid');
    expect(again.map((h) => h.chunkId)).toEqual(hybrid.map((h) => h.chunkId));
  });

  it('mode:hybrid+rerank reorders deterministically + preserves trust', async () => {
    const tenantId = 'kbh-rerank';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Partial', text: 'The migration plan mentions runbook steps.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, untrustedUpload('Full', 'The database migration runbook plan covers every step in detail.'));

    const hits = await search(tenantId, orgId, col.collectionId, 'migration runbook plan', 5, 'hybrid+rerank');
    expect(hits.length).toBeGreaterThan(0);
    // 'Full' holds the query as an exact phrase → reranks first.
    expect(hits[0]!.title).toBe('Full');
    expect(hits[0]!.contentTrust).toBe('untrusted');
    expect(hits.find((h) => h.title === 'Partial')!.contentTrust).toBe('trusted');
    const again = await search(tenantId, orgId, col.collectionId, 'migration runbook plan', 5, 'hybrid+rerank');
    expect(again.map((h) => h.chunkId)).toEqual(hits.map((h) => h.chunkId)); // deterministic
  });

  it('mode:dense remains the unchanged default', async () => {
    const tenantId = 'kbh-tenant2';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Finance', text: 'The annual budget summary and revenue plan for the annual budget review.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Budget notes', text: 'Budget notes: the annual budget is approved.' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Tickets', text: 'Reference ZX-4471 covers the migration runbook.' });
    const q = '4471 budget';
    const dense = (await search(tenantId, orgId, col.collectionId, q, 3, 'dense')).map((h) => h.chunkId);
    const hybrid = (await search(tenantId, orgId, col.collectionId, q, 3, 'hybrid')).map((h) => h.chunkId);
    expect(hybrid, 'fixture precondition: the two modes must disagree').not.toEqual(dense);
    expect((await search(tenantId, orgId, col.collectionId, q, 3)).map((h) => h.chunkId)).toEqual(dense);
  });
});
