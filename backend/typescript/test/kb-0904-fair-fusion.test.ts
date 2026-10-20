/**
 * ADR 0904 D4 / P0 — fair cross-collection fusion + a calibrated relevance.
 *
 * `tenantRetrieve` (what `ctx.knowledge`, `openwop:knowledge.search` and agent knowledge
 * read through) concatenated each collection's hits and sorted them by RAW score. Scores
 * are on the collection's MODE's scale — cosine ≈0–1, RRF ≈0.03, local rerank up to ≈8 —
 * so a `hybrid+rerank` collection outranked a `dense` one whatever the relevance, and a
 * `hybrid` collection (≈0.03) sank under everything. On the P0 eval corpus the mixed-mode
 * lane measured recall@5 0.425 before and 0.708 after, with French (the `hybrid`
 * collection) at 0.000 before.
 *
 * Pinned here:
 *  - ordering is RRF over each collection's own ranking (the dense exact hit is not
 *    buried by a reranked irrelevant one) — sabotage: restore the raw-score sort ⇒ red;
 *  - keyword-only relevance is saturated BM25, so across collections a strong exact match
 *    beats an incidental one — sabotage: BM25 / the collection's top ⇒ red;
 *  - `relevanceScore` is calibrated 0–1, so `scoreThreshold` and the vendor pack's
 *    `scoreFloor` keep a hybrid collection's hits — sabotage: threshold on `score` ⇒ red;
 *  - `ragQuery({minScore})` applies to the same calibrated value (the campaign-channels
 *    strict floor is 0.25, which used to drop every hybrid context);
 *  - `nativeScore` + `fusedRank` ride along;
 *  - the eval harness reproduces `scripts/kb-eval/baseline.json` exactly (local-hash is
 *    deterministic, so any retrieval change shows up as a diff here first).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createCollection, ingestDocument, ragQuery, setRetrievalConfig, tenantRetrieve, KB_MAINTENANCE_CALLER, type RetrievalMode } from '../src/features/kb/kbService.js';
import { tokenize } from '../src/features/kb/lexicalIndex.js';
import { loadCorpus, runKbEval, scoreQuery } from '../scripts/kb-eval/harness.js';

const here = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kb0904-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

const ORG = 'org-a';
async function seed(tenantId: string, collectionId: string, mode: RetrievalMode, docs: Array<[string, string]>): Promise<void> {
  await createCollection(tenantId, ORG, 'actor', { name: collectionId }, { collectionId });
  await setRetrievalConfig(tenantId, ORG, collectionId, 'actor', { mode });
  for (const [title, text] of docs) await ingestDocument(tenantId, ORG, 'actor', collectionId, { title, text }, { documentId: `${collectionId}-${title}` });
}

/** A `dense` collection holding the one exact answer, beside a `hybrid+rerank` collection
 *  of loosely related text whose local-rerank scores (≈1–8) dwarf any cosine. */
async function mixedTenant(tenantId: string): Promise<void> {
  await seed(tenantId, 'ops', 'dense', [
    ['Error codes', 'Error ZX-4471 means the tidewater database migration lock is held; release it with the unlock runbook.'],
    ['Lunch menu', 'Tuesday lunch is tacos and a salad bar in the cafeteria.'],
  ]);
  await seed(tenantId, 'misc', 'hybrid+rerank', [
    ['Migration FAQ', 'General migration questions: plan the migration, read the runbook, ask in the migration channel.'],
    ['Runbook index', 'An index of every runbook, migration guide and checklist we keep.'],
  ]);
}

describe('ADR 0904 D4 — tenantRetrieve fuses collections fairly', () => {
  it('a dense exact hit is not buried under a reranked collection’s loose matches', async () => {
    await mixedTenant('t-fair');
    const r = await tenantRetrieve('t-fair', { query: 'ZX-4471 migration lock runbook', resultLimit: 4 }, KB_MAINTENANCE_CALLER);
    expect(r?.chunks.length).toBeGreaterThan(0);
    // Precondition: the reranked collection's NATIVE score dwarfs the dense cosine, so a
    // raw-score merge would put it first — this is the defect the fix exists for.
    const exact = r!.chunks.find((c) => c.documentTitle === 'Error codes')!;
    const loose = r!.chunks.filter((c) => c.collectionId === 'misc');
    expect(loose.length, 'fixture: the reranked collection answered').toBeGreaterThan(0);
    expect(Math.max(...loose.map((c) => c.nativeScore!)), 'fixture: rerank scale > cosine scale').toBeGreaterThan(exact.nativeScore!);
    expect(r!.chunks[0]!.documentTitle).toBe('Error codes');
    expect(r!.chunks.map((c) => c.fusedRank)).toEqual(r!.chunks.map((_, i) => i + 1));
  });

  it('keyword-only collections tie-break on absolute BM25 strength, not on a per-collection 1.0', async () => {
    // `embedder:'provider'` with no BYOK key ⇒ both collections answer keyword-only
    // (labelled), so each one's best hit is its rank 0 and the RRF scores tie. The first
    // calibration (BM25 / the collection's top BM25) made both 1.0 and the id decided:
    // 'a-noise' first. Saturation keeps the strong exact match ahead.
    const t = 't-lexical';
    await seed(t, 'a-noise', 'dense', [['Index', 'A pallet is mentioned once here among many unrelated words about lunch menus and parking.'], ['Lunch', 'Tuesday lunch is tacos and a salad bar in the cafeteria.'], ['Parking', 'Visitor parking is on level two of the north garage.'], ['Wifi', 'The guest wifi password rotates every Monday morning.']]);
    await seed(t, 'z-answer', 'dense', [['Pallet rules', 'Pallet rules: pallets stack two high. Pallet rules: every pallet is wrapped. These rules apply to every pallet.'], ['Lunch', 'Tuesday lunch is tacos and a salad bar in the cafeteria.'], ['Parking', 'Visitor parking is on level two of the north garage.'], ['Wifi', 'The guest wifi password rotates every Monday morning.']]);
    for (const c of ['a-noise', 'z-answer']) await setRetrievalConfig(t, ORG, c, 'actor', { embedder: 'provider' });
    const r = await tenantRetrieve(t, { query: 'pallet rules', resultLimit: 4 }, KB_MAINTENANCE_CALLER);
    expect(r!.chunks.map((c) => c.collectionId)).toEqual(['z-answer', 'a-noise']);
    expect(r!.chunks[0]!.relevanceScore).toBeLessThan(1);
  });

  it('relevanceScore is calibrated to [0,1] on every mode, with the native score kept apart', async () => {
    const r = await tenantRetrieve('t-fair', { query: 'migration runbook', resultLimit: 10 }, KB_MAINTENANCE_CALLER);
    for (const c of r!.chunks) {
      expect(c.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(c.relevanceScore).toBeLessThanOrEqual(1);
      expect(typeof c.nativeScore).toBe('number');
    }
  });

  it('scoreThreshold applies to the calibrated relevance — a hybrid collection survives a 0.2 floor', async () => {
    await seed('t-floor', 'h', 'hybrid', [
      ['Cold chain', 'Cold-chain pallets stay between 2 and 8 degrees Celsius from dock to truck.'],
      ['Forklifts', 'Forklift certification renews every three years.'],
    ]);
    const r = await tenantRetrieve('t-floor', { query: 'cold-chain pallets degrees', resultLimit: 5, scoreThreshold: 0.2 }, KB_MAINTENANCE_CALLER);
    // Hybrid native scores are RRF (≈0.03): a raw-score threshold dropped every chunk.
    expect(r!.chunks.map((c) => c.documentTitle)).toContain('Cold chain');
    expect(r!.chunks.every((c) => c.nativeScore! < 0.2), 'fixture: native RRF scores are all under the floor').toBe(true);
  });

  it('the vendor knowledge.retrieve scoreFloor keeps hybrid hits (the "host-normalized relevance" its manifest promises)', async () => {
    // The vendor pack is untyped .mjs: a non-literal specifier needs no declaration file
    // or suppression (the adr0830-kb-ratchets pattern); the export is checked at runtime.
    const loaded: { knowledgeRetrieve?: unknown } = await import(pathToFileURL(join(here, '../../../packs/vendor.myndhyve.knowledge-tools/index.mjs')).href);
    expect(typeof loaded.knowledgeRetrieve).toBe('function');
    const knowledgeRetrieve = loaded.knowledgeRetrieve as (ctx: unknown) => Promise<unknown>;
    const out = await knowledgeRetrieve({
      inputs: { query: 'cold-chain pallets degrees' },
      config: { scoreFloor: 0.2 },
      knowledge: { retrieve: (args: Parameters<typeof tenantRetrieve>[1]) => tenantRetrieve('t-floor', args, KB_MAINTENANCE_CALLER) },
    }) as { status: string; outputs: { chunks: Array<{ documentTitle: string }>; droppedByScoreFloor: number } };
    expect(out.status).toBe('success');
    expect(out.outputs.chunks.map((c) => c.documentTitle)).toContain('Cold chain');
  });

  it('ragQuery minScore applies to the calibrated relevance (hybrid collection, strict 0.25 floor)', async () => {
    const r = await ragQuery('t-floor', ORG, 'h', 'cold-chain pallets degrees', 5, { minScore: 0.25 }, KB_MAINTENANCE_CALLER);
    expect(r.coverage).not.toBe('none');
    expect(r.contexts.map((c) => c.title)).toContain('Cold chain');
  });
});

describe('ADR 0904 P0 — BM25 tokenizer folds diacritics', () => {
  it('keeps accented words whole and matches them typed without the accent', () => {
    expect(tokenize('Información básica')).toEqual(['informacion', 'basica']);
    expect(tokenize('Ação, férias e São Paulo')).toEqual(['acao', 'ferias', 'e', 'sao', 'paulo']);
    expect(tokenize('Invoice INV-9981!')).toEqual(['invoice', 'inv', '9981']);
  });
});

describe('ADR 0904 P0 — retrieval eval harness', () => {
  it('scores a ranking: recall@5, reciprocal rank, graded nDCG', () => {
    const s = scoreQuery(['x', 'a', 'y', 'b'], [{ doc: 'a', grade: 2 }, { doc: 'b', grade: 1 }]);
    expect(s.recallAt5).toBe(1);
    expect(s.rr).toBe(0.5);
    const ideal = 3 / Math.log2(2) + 1 / Math.log2(3);
    const actual = 3 / Math.log2(3) + 1 / Math.log2(5);
    expect(s.ndcgAt10).toBeCloseTo(actual / ideal, 10);
    expect(scoreQuery(['x'], [{ doc: 'a', grade: 2 }])).toEqual({ recallAt5: 0, rr: 0, ndcgAt10: 0 });
  });

  it('reproduces baseline.json exactly on the deterministic local-hash embedder', async () => {
    const report = await runKbEval(loadCorpus(join(here, 'fixtures/kb-eval/corpus.json')), { tenantPrefix: 'kb-eval-smoke' });
    expect(report.embedder).toBe('local:local-hash-v1');
    const baseline = JSON.parse(readFileSync(join(here, '../scripts/kb-eval/baseline.json'), 'utf8')) as unknown;
    expect(report).toEqual(baseline);
  }, 60_000);
});
